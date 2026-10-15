import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, type Http2SessionManager } from "@connectrpc/connect-node";

import { pollBackoffMs } from "./constants.js";
import { DataPlaneNotReadyError, InvalidStateError, isPausedSessionStateError } from "./errors.js";
import { DrainingHttp2SessionManager, KEEPALIVE_PING_OPTIONS } from "./http2-drain.js";
import {
  DataPlaneRouteStatus,
  SandboxSessionDataPlaneService,
  type SessionCredential,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { refusedStreamRetry } from "./refused-stream.js";
import type { Session } from "./session.js";

export const dataPlaneCredentialHeader = "x-tenki-session-cert";

interface SharedDataPlaneSessionManager {
  manager: Http2SessionManager;
  origin: string;
  references: number;
}

const sharedDataPlaneSessionManagers = new Map<string, SharedDataPlaneSessionManager>();
const dataPlaneSessionManagers = new WeakMap<object, SharedDataPlaneSessionManager>();

export interface DataPlaneConfig {
  endpoint?: string;
  credential?: SessionCredential;
  routeStatus?: DataPlaneRouteStatus;
}

export class DataPlaneEndpointHints {
  private endpoint = "";
  private resolving?: Promise<string>;

  current(): string {
    return this.endpoint;
  }

  remember(endpoint: string): void {
    const resolved = endpoint.trim();
    if (resolved) this.endpoint = resolved;
  }

  clear(): void {
    this.endpoint = "";
  }

  async resolve(resolveEndpoint: () => Promise<string>): Promise<string> {
    for (;;) {
      if (this.endpoint) return this.endpoint;
      const owner = !this.resolving;
      if (owner) {
        this.resolving = resolveEndpoint().then((endpoint) => {
          this.remember(endpoint);
          return endpoint;
        });
      }
      const resolving = this.resolving;
      if (!resolving) continue;
      try {
        return await resolving;
      } catch (err) {
        if (owner) throw err;
      } finally {
        if (this.resolving === resolving) this.resolving = undefined;
      }
    }
  }
}

export class DataPlaneCredentialManager {
  #credential = "";
  // #endpoint is the endpoint #credential was minted for. A data-plane
  // credential authorizes one session on one node, so it is only ever handed
  // to a client aimed at that endpoint. An empty value means the engine
  // returned a credential before the endpoint was known, and the first
  // endpoint the session resolves to adopts it.
  #endpoint = "";
  private expiresAt?: Date;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly session: Session,
    initial?: SessionCredential,
    endpoint = "",
  ) {
    this.set(initial, endpoint);
  }

  current(): string {
    return this.#credential;
  }

  /** The credential, but only for the endpoint it was minted for. */
  currentFor(endpoint: string): { credential: string; bound: true } | { bound: false } {
    if (!this.#credential) return { credential: "", bound: true };
    if (this.#endpoint !== endpoint) return { bound: false };
    return { credential: this.#credential, bound: true };
  }

  /** Bind an unbound credential to the first endpoint the session resolves to. */
  adoptEndpoint(endpoint: string): void {
    if (this.#credential && !this.#endpoint) this.#endpoint = endpoint;
  }

  set(credential?: SessionCredential, endpoint = ""): void {
    if (!credential?.credential || this.stopped) return;
    this.#credential = credential.credential;
    this.#endpoint = endpoint;
    this.expiresAt = credential.expiresAt ? timestampDate(credential.expiresAt) : undefined;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped || !this.expiresAt) return;
    if (this.timer) clearTimeout(this.timer);
    const remainingMs = this.expiresAt.getTime() - Date.now();
    const delayMs = Math.max(1_000, Math.floor(remainingMs / 2));
    this.timer = setTimeout(() => void this.renewLoop(), delayMs);
    this.timer.unref?.();
  }

  private async renewLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        if (await this.session.renewDataPlaneCredential()) return;
      } catch (err) {
        // Retry only transient readiness errors; stop on terminal route failure or fatal errors (auth/not-found) instead of spinning forever, and never rethrow out of this fire-and-forget loop.
        const retryable =
          (err instanceof DataPlaneNotReadyError && !err.terminal) ||
          (err instanceof InvalidStateError && !isPausedSessionStateError(err));
        if (!retryable) {
          this.stopped = true;
          return;
        }
      }
      const delayMs = Math.max(1_000, pollBackoffMs(attempt));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempt++;
    }
  }
}

export function createDataPlaneClient(
  endpoint: string,
  credentials: DataPlaneCredentialManager,
  sessionId: string,
): Client<typeof SandboxSessionDataPlaneService> {
  // The interceptor is bound to the session and endpoint this client targets.
  // A credential minted for another node, or a request naming another session,
  // is refused here rather than sent to the wrong destination.
  const credentialInterceptor: Interceptor = (next) => async (req) => {
    if (!req.stream) validateRequestSession(req.message, sessionId);
    const current = credentials.currentFor(endpoint);
    if (!current.bound) {
      throw new ConnectError(
        `sandbox: refusing to send a data-plane credential to the wrong destination: credential was minted for another endpoint, not ${endpoint}`,
        Code.PermissionDenied,
      );
    }
    if (current.credential) req.header.set(dataPlaneCredentialHeader, current.credential);
    return req.stream ? next({ ...req, message: validateStreamRequests(req.message, sessionId) }) : next(req);
  };
  // refusedStreamRetry is outermost so a retried attempt re-runs the credential
  // interceptor (fresh connection re-applies auth).
  const origin = new URL(endpoint).origin;
  let sharedSessionManager = sharedDataPlaneSessionManagers.get(origin);
  if (!sharedSessionManager) {
    sharedSessionManager = {
      manager: new DrainingHttp2SessionManager(origin, KEEPALIVE_PING_OPTIONS),
      origin,
      references: 0,
    };
    sharedDataPlaneSessionManagers.set(origin, sharedSessionManager);
  }
  sharedSessionManager.references++;
  const transport = createGrpcTransport({
    baseUrl: endpoint,
    interceptors: [refusedStreamRetry, credentialInterceptor],
    sessionManager: sharedSessionManager.manager,
  });
  const client = createClient(SandboxSessionDataPlaneService, transport);
  dataPlaneSessionManagers.set(client, sharedSessionManager);
  return client;
}

function validateRequestSession(message: unknown, sessionId: string): void {
  const requested = requestSessionId(message);
  if (requested && requested !== sessionId) {
    throw new ConnectError(
      `sandbox: refusing to send a data-plane credential to the wrong destination: request targets session ${requested} on a client credentialed for session ${sessionId}`,
      Code.PermissionDenied,
    );
  }
}

async function* validateStreamRequests<T>(messages: AsyncIterable<T>, sessionId: string): AsyncGenerator<T> {
  for await (const message of messages) {
    validateRequestSession(message, sessionId);
    yield message;
  }
}

function requestSessionId(message: unknown, depth = 3): string | undefined {
  if (typeof message !== "object" || message === null || ArrayBuffer.isView(message)) return undefined;
  const direct = (message as { sessionId?: unknown }).sessionId;
  if (typeof direct === "string" && direct) return direct;
  if (depth <= 0) return undefined;
  for (const value of Object.values(message)) {
    if (Array.isArray(value)) continue;
    const nested = requestSessionId(value, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

export async function warmDataPlaneConnection(client: Client<typeof SandboxSessionDataPlaneService>) {
  await dataPlaneSessionManagers.get(client)?.manager.connect();
}

export function closeDataPlaneConnection(client?: Client<typeof SandboxSessionDataPlaneService>) {
  if (!client) return;
  const sharedSessionManager = dataPlaneSessionManagers.get(client);
  if (!sharedSessionManager) return;
  dataPlaneSessionManagers.delete(client);
  sharedSessionManager.references--;
  if (sharedSessionManager.references > 0) return;
  if (sharedDataPlaneSessionManagers.get(sharedSessionManager.origin) === sharedSessionManager) {
    sharedDataPlaneSessionManagers.delete(sharedSessionManager.origin);
  }
  sharedSessionManager.manager.abort();
}

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";

import { pollBackoffMs } from "./constants.js";
import { DataPlaneNotReadyError, InvalidStateError, isPausedSessionStateError } from "./errors.js";
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
  private credential = "";
  private expiresAt?: Date;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly session: Session,
    initial?: SessionCredential,
  ) {
    this.set(initial);
  }

  current(): string {
    return this.credential;
  }

  set(credential?: SessionCredential): void {
    if (!credential?.credential) return;
    this.credential = credential.credential;
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
): Client<typeof SandboxSessionDataPlaneService> {
  const credentialInterceptor: Interceptor = (next) => async (req) => {
    const credential = credentials.current();
    if (credential) req.header.set(dataPlaneCredentialHeader, credential);
    return next(req);
  };
  // refusedStreamRetry is outermost so a retried attempt re-runs the credential
  // interceptor (fresh connection re-applies auth).
  const origin = new URL(endpoint).origin;
  let sharedSessionManager = sharedDataPlaneSessionManagers.get(origin);
  if (!sharedSessionManager) {
    sharedSessionManager = {
      manager: new Http2SessionManager(origin),
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

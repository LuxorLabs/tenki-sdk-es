import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

import { createAuthInterceptor, resolveAuthToken } from "./auth.js";
import { CLOUD_API_URL_ENVS, DEFAULT_BASE_URL } from "./constants.js";
import { readEnv } from "./env.js";
import { DrainingHttp2SessionManager } from "./http2-drain.js";
import * as pb from "./internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";
import { Secrets } from "./workspace-secrets.js";

export interface WorkspaceOptions {
  workspaceId?: string;
  authToken?: string;
  /** Alias for authToken. Pass one or the other, not both. */
  apiKey?: string;
  /** Cloud API endpoint, independent of sandbox endpoint configuration. */
  baseUrl?: string;
  transport?: Transport;
  timeoutMs?: number;
  rootCertificates?: string | Buffer | Array<string | Buffer>;
}
/** Owns workspace scope, authentication, and connection lifetime. */
export class WorkspaceClient implements AsyncDisposable {
  readonly secrets: Secrets;
  private readonly sessionManager?: DrainingHttp2SessionManager;
  constructor(options: WorkspaceOptions = {}) {
    const token = resolveAuthToken(options.authToken, options.apiKey);
    const baseUrl = options.baseUrl || readEnv(CLOUD_API_URL_ENVS) || DEFAULT_BASE_URL;
    this.sessionManager = options.transport
      ? undefined
      : new DrainingHttp2SessionManager(
          baseUrl,
          undefined,
          options.rootCertificates !== undefined ? { ca: options.rootCertificates } : undefined,
        );
    this.secrets = new Secrets(
      options.workspaceId ?? "",
      createClient(
        pb.WorkspaceSecretsService,
        options.transport ??
          createGrpcTransport({
            baseUrl,
            defaultTimeoutMs: options.timeoutMs ?? 30_000,
            sessionManager: this.sessionManager,
            interceptors: [createAuthInterceptor(token)],
          }),
      ),
    );
  }
  async close(): Promise<void> {
    await this.sessionManager?.abort();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

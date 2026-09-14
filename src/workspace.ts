import { createClient, type Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

import { createAuthInterceptor, validateAuthToken } from "./auth.js";
import { DrainingHttp2SessionManager } from "./http2-drain.js";
import * as pb from "./internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";
import { Secrets } from "./workspace-secrets.js";

export interface WorkspaceOptions {
  workspaceId?: string;
  authToken?: string;
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
    const token = validateAuthToken(
      options.authToken || process.env.TENKI_AUTH_TOKEN || process.env.TENKI_API_KEY || "",
    );
    const baseUrl = options.baseUrl || process.env.TENKI_CLOUD_API_URL || "https://api.tenki.cloud";
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

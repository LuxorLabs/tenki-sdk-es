import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import * as pb from "./internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";
import { SecretPolicies } from "./secret-policies.js";

export class WorkspaceSecretError extends Error {
  constructor(
    message: string,
    readonly code: Code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceSecretError";
  }
}
export function workspaceSecretError(error: unknown): Error {
  if (!(error instanceof ConnectError)) return error instanceof Error ? error : new Error(String(error));
  return new WorkspaceSecretError(error.rawMessage, error.code, { cause: error });
}

export interface WorkspaceSecret {
  id: string;
  workspaceId: string;
  name: string;
  /** Repository (owner/name) whose CI jobs get the secret; undefined for a workspace secret. */
  repository?: string;
  activeVersion: number;
  revision: number;
  createdAt?: Date;
  updatedAt?: Date;
  revokedAt?: Date;
  deletedAt?: Date;
}
export interface WorkspaceSecretVersion {
  version: number;
  createdAt?: Date;
  revokedAt?: Date;
}
export interface SecretMutationOptions {
  expectedRevision: number;
  requestId?: string;
}
export interface UpdateSecretOptions extends SecretMutationOptions {
  /** Omitted retains the value; an empty array creates an empty value. */
  value?: Uint8Array;
  activeVersion?: number;
}
export interface SecretPageOptions {
  pageSize?: number;
  cursor?: string;
}
export interface SecretRepositoryPageOptions extends SecretPageOptions {
  /** Case-insensitive substring match on the full name. */
  search?: string;
}

function metadata(secret: pb.Secret | undefined): WorkspaceSecret {
  if (!secret) throw new Error("Missing secret metadata");
  return {
    id: secret.id,
    workspaceId: secret.workspaceId,
    name: secret.name,
    repository: secret.repository || undefined,
    activeVersion: secret.activeVersion,
    revision: secret.revision,
    createdAt: secret.createdAt && timestampDate(secret.createdAt),
    updatedAt: secret.updatedAt && timestampDate(secret.updatedAt),
    revokedAt: secret.revokedAt && timestampDate(secret.revokedAt),
    deletedAt: secret.deletedAt && timestampDate(secret.deletedAt),
  };
}

/** Access through WorkspaceClient.secrets. Reads return metadata only. */
export class Secrets {
  readonly policies: SecretPolicies;
  constructor(
    private readonly workspaceId: string,
    private readonly rpc: Client<typeof pb.WorkspaceSecretsService>,
  ) {
    this.policies = new SecretPolicies(workspaceId, rpc);
  }
  /** Creates a workspace secret. */
  async create(name: string, value: Uint8Array, requestId = randomUUID()): Promise<WorkspaceSecret> {
    return this.createSecret("", name, value, requestId);
  }
  /**
   * Creates a secret only CI jobs in `repository` (owner/name) get, replacing a workspace secret with the
   * same name. The repository must be connected to the workspace.
   */
  async createForRepository(
    repository: string,
    name: string,
    value: Uint8Array,
    requestId = randomUUID(),
  ): Promise<WorkspaceSecret> {
    if (!/^[^/]+\/[^/]+$/.test(repository)) {
      throw new Error(`repository must be owner/name, got ${JSON.stringify(repository)}`);
    }
    return this.createSecret(repository, name, value, requestId);
  }
  private async createSecret(
    repository: string,
    name: string,
    value: Uint8Array,
    requestId: string,
  ): Promise<WorkspaceSecret> {
    try {
      return metadata(
        (
          await this.rpc.createSecret(
            create(pb.CreateSecretRequestSchema, {
              workspaceId: this.workspaceId,
              name,
              value,
              requestId,
              repository,
            }),
          )
        ).secret,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async update(secretId: string, options: UpdateSecretOptions): Promise<WorkspaceSecret> {
    const request = create(pb.UpdateSecretRequestSchema, {
      workspaceId: this.workspaceId,
      secretId,
      value: options.value,
      activeVersion: options.activeVersion,
      expectedRevision: options.expectedRevision,
      requestId: options.requestId ?? randomUUID(),
    });
    try {
      return metadata((await this.rpc.updateSecret(request)).secret);
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async get(secretId: string): Promise<WorkspaceSecret> {
    try {
      return metadata((await this.rpc.getSecret({ workspaceId: this.workspaceId, secretId })).secret);
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async list(options: SecretPageOptions = {}): Promise<{ secrets: WorkspaceSecret[]; nextCursor: string }> {
    try {
      const response = await this.rpc.listSecrets({ ...options, workspaceId: this.workspaceId });
      return { secrets: response.secrets.map(metadata), nextCursor: response.nextCursor };
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  /** Lists the connected repositories (owner/name) createForRepository accepts, ordered by name. */
  async listRepositories(
    options: SecretRepositoryPageOptions = {},
  ): Promise<{ repositories: string[]; nextCursor: string }> {
    try {
      const response = await this.rpc.listSecretRepositories({ ...options, workspaceId: this.workspaceId });
      return {
        repositories: response.repositories.map((repository) => repository.fullName),
        nextCursor: response.nextCursor,
      };
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async listVersions(
    secretId: string,
    options: SecretPageOptions = {},
  ): Promise<{ versions: WorkspaceSecretVersion[]; nextCursor: string }> {
    try {
      const response = await this.rpc.listSecretVersions({ ...options, workspaceId: this.workspaceId, secretId });
      return {
        versions: response.versions.map((version) => ({
          version: version.version,
          createdAt: version.createdAt && timestampDate(version.createdAt),
          revokedAt: version.revokedAt && timestampDate(version.revokedAt),
        })),
        nextCursor: response.nextCursor,
      };
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async revoke(secretId: string, options: SecretMutationOptions & { version?: number }): Promise<WorkspaceSecret> {
    try {
      return metadata(
        (
          await this.rpc.revokeSecret({
            ...options,
            workspaceId: this.workspaceId,
            secretId,
            requestId: options.requestId ?? randomUUID(),
          })
        ).secret,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async delete(secretId: string, options: SecretMutationOptions): Promise<WorkspaceSecret> {
    try {
      return metadata(
        (
          await this.rpc.deleteSecret({
            ...options,
            workspaceId: this.workspaceId,
            secretId,
            requestId: options.requestId ?? randomUUID(),
          })
        ).secret,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
}

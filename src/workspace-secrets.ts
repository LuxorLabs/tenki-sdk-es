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

/** Where a secret applies: every CI job and sandbox in the workspace, or CI jobs in one repository. */
export type SecretAvailability = "workspace" | "repository";

export interface WorkspaceSecret {
  id: string;
  workspaceId: string;
  name: string;
  /** Repository (owner/name) whose CI jobs get the secret; undefined for a workspace secret. */
  repository?: string;
  /** One-line note for the people who manage the secret; undefined when there is none. */
  description?: string;
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
export interface CreateSecretOptions {
  requestId?: string;
  /** Gives the secret only to CI jobs in this connected repository (owner/name); omit for a workspace secret. */
  repository?: string;
  description?: string;
}
/**
 * Changes only what is set. A value or activeVersion makes that version active and restores a revoked
 * secret; description and availability changes don't.
 */
export interface UpdateSecretOptions extends SecretMutationOptions {
  /** Omitted retains the value; an empty array creates an empty value. */
  value?: Uint8Array;
  activeVersion?: number;
  /** An empty string clears the description. */
  description?: string;
  /** Omitted keeps the availability unless `repository` is set; "repository", or `repository` alone, moves the secret there. */
  availability?: SecretAvailability;
  repository?: string;
}
export interface SecretPageOptions {
  pageSize?: number;
  cursor?: string;
}
export interface ListSecretsOptions extends SecretPageOptions {
  /** Omitted lists workspace and repository secrets; `repository`, with or without "repository", narrows to one repository. */
  availability?: SecretAvailability;
  repository?: string;
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
    description: secret.description || undefined,
    activeVersion: secret.activeVersion,
    revision: secret.revision,
    createdAt: secret.createdAt && timestampDate(secret.createdAt),
    updatedAt: secret.updatedAt && timestampDate(secret.updatedAt),
    revokedAt: secret.revokedAt && timestampDate(secret.revokedAt),
    deletedAt: secret.deletedAt && timestampDate(secret.deletedAt),
  };
}

function checkRepository(repository: string): void {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error(`repository must be owner/name, got ${JSON.stringify(repository)}`);
  }
}

/** A repository without an availability means repository availability, and workspace refuses one, as in the CLI. */
function secretAvailability(availability: SecretAvailability | undefined, repository?: string): pb.SecretAvailability {
  if (repository) {
    if (availability === "workspace") throw new Error("availability workspace cannot be combined with a repository");
    checkRepository(repository);
  }
  switch (availability) {
    case undefined:
      return repository ? pb.SecretAvailability.REPOSITORY : pb.SecretAvailability.UNSPECIFIED;
    case "workspace":
      return pb.SecretAvailability.WORKSPACE;
    case "repository":
      return pb.SecretAvailability.REPOSITORY;
  }
  throw new Error(`unknown secret availability ${JSON.stringify(availability)}`);
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
  /**
   * Creates a secret. With `repository`, only CI jobs in that connected repository get it, in place of a
   * workspace secret with the same name. A string `options` is the request ID, as in 1.4.
   */
  async create(name: string, value: Uint8Array, options: string | CreateSecretOptions = {}): Promise<WorkspaceSecret> {
    const {
      requestId = randomUUID(),
      repository = "",
      description = "",
    } = typeof options === "string" ? { requestId: options } : options;
    if (repository) checkRepository(repository);
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
              description,
            }),
          )
        ).secret,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async update(secretId: string, options: UpdateSecretOptions): Promise<WorkspaceSecret> {
    const availability = secretAvailability(options.availability, options.repository);
    if (availability === pb.SecretAvailability.REPOSITORY) checkRepository(options.repository ?? "");
    const request = create(pb.UpdateSecretRequestSchema, {
      workspaceId: this.workspaceId,
      secretId,
      value: options.value,
      activeVersion: options.activeVersion,
      description: options.description,
      availability,
      repository: options.repository,
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
  async list(options: ListSecretsOptions = {}): Promise<{ secrets: WorkspaceSecret[]; nextCursor: string }> {
    const availability = secretAvailability(options.availability, options.repository);
    try {
      const response = await this.rpc.listSecrets({ ...options, workspaceId: this.workspaceId, availability });
      return { secrets: response.secrets.map(metadata), nextCursor: response.nextCursor };
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  /** Lists the connected repositories (owner/name) a secret can be limited to, ordered by name. */
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

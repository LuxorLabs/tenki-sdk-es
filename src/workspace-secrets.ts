import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import * as pb from "./internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";

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
function workspaceSecretError(error: unknown): Error {
  if (!(error instanceof ConnectError)) return error instanceof Error ? error : new Error(String(error));
  return new WorkspaceSecretError(error.rawMessage, error.code, { cause: error });
}

export type SecretDeliveryMode = "guest_and_injection" | "injection_only";
export type SecretDestinationMode = "unset" | "allowlist" | "allow_any";
export interface SecretPolicy {
  deliveryMode: SecretDeliveryMode;
  destinationMode: SecretDestinationMode;
  allowedHosts?: string[];
}
export interface WorkspaceSecret {
  id: string;
  workspaceId: string;
  name: string;
  activeVersion: number;
  revision: number;
  policy: SecretPolicy;
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
  policy?: SecretPolicy;
  activeVersion?: number;
}
export interface SecretPageOptions {
  pageSize?: number;
  cursor?: string;
}

function policyToProto(policy: SecretPolicy): pb.SecretPolicy {
  const deliveryMode = {
    guest_and_injection: pb.SecretDeliveryMode.GUEST_AND_INJECTION,
    injection_only: pb.SecretDeliveryMode.INJECTION_ONLY,
  }[policy.deliveryMode];
  const destinationMode = {
    unset: pb.SecretDestinationMode.UNSET,
    allowlist: pb.SecretDestinationMode.ALLOWLIST,
    allow_any: pb.SecretDestinationMode.ALLOW_ANY,
  }[policy.destinationMode];
  if (deliveryMode === undefined || destinationMode === undefined) throw new Error("Invalid secret policy mode");
  return create(pb.SecretPolicySchema, { deliveryMode, destinationMode, allowedHosts: policy.allowedHosts ?? [] });
}
function metadata(secret: pb.Secret | undefined): WorkspaceSecret {
  if (!secret?.policy) throw new Error("Missing secret metadata");
  const deliveryMode = (
    {
      [pb.SecretDeliveryMode.GUEST_AND_INJECTION]: "guest_and_injection",
      [pb.SecretDeliveryMode.INJECTION_ONLY]: "injection_only",
    } as const
  )[secret.policy.deliveryMode as 1 | 2];
  const destinationMode = (
    {
      [pb.SecretDestinationMode.UNSET]: "unset",
      [pb.SecretDestinationMode.ALLOWLIST]: "allowlist",
      [pb.SecretDestinationMode.ALLOW_ANY]: "allow_any",
    } as const
  )[secret.policy.destinationMode as 1 | 2 | 3];
  if (!deliveryMode || !destinationMode) throw new Error("Unknown secret policy mode");
  return {
    id: secret.id,
    workspaceId: secret.workspaceId,
    name: secret.name,
    activeVersion: secret.activeVersion,
    revision: secret.revision,
    policy: { deliveryMode, destinationMode, allowedHosts: [...secret.policy.allowedHosts] },
    createdAt: secret.createdAt && timestampDate(secret.createdAt),
    updatedAt: secret.updatedAt && timestampDate(secret.updatedAt),
    revokedAt: secret.revokedAt && timestampDate(secret.revokedAt),
    deletedAt: secret.deletedAt && timestampDate(secret.deletedAt),
  };
}

/** Access through WorkspaceClient.secrets. Reads return metadata only. */
export class Secrets {
  constructor(
    private readonly workspaceId: string,
    private readonly rpc: Client<typeof pb.WorkspaceSecretsService>,
  ) {}
  async create(
    name: string,
    value: Uint8Array,
    policy: SecretPolicy,
    requestId = randomUUID(),
  ): Promise<WorkspaceSecret> {
    try {
      return metadata(
        (
          await this.rpc.createSecret(
            create(pb.CreateSecretRequestSchema, {
              workspaceId: this.workspaceId,
              name,
              value,
              policy: policyToProto(policy),
              requestId,
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
      policy: options.policy && policyToProto(options.policy),
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

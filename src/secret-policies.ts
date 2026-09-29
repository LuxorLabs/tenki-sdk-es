import { randomUUID } from "node:crypto";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { Client } from "@connectrpc/connect";

import * as pb from "./internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";
import { workspaceSecretError, type SecretMutationOptions, type SecretPageOptions } from "./workspace-secrets.js";

export interface SecretRequestRule {
  origin: string;
  methods: string[];
  pathPrefix: string;
  header?: string;
  queryParameter?: string;
  jsonPointer?: string;
  secrets: string[];
}
export interface WorkspaceSecretPolicy {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  attachedSessionCount: number;
  rules: SecretRequestRule[];
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}
function metadata(policy: pb.SecretAccessPolicy | undefined): WorkspaceSecretPolicy {
  if (!policy) throw new Error("Missing secret policy metadata");
  return {
    id: policy.id,
    workspaceId: policy.workspaceId,
    name: policy.name,
    revision: policy.revision,
    attachedSessionCount: policy.attachedSessionCount,
    rules: policy.rules.map((rule) => ({
      origin: rule.origin,
      methods: [...rule.methods],
      pathPrefix: rule.pathPrefix,
      header: rule.header || undefined,
      queryParameter: rule.queryParameter || undefined,
      jsonPointer: rule.jsonPointer || undefined,
      secrets: [...rule.secrets],
    })),
    createdAt: policy.createdAt && timestampDate(policy.createdAt),
    updatedAt: policy.updatedAt && timestampDate(policy.updatedAt),
    deletedAt: policy.deletedAt && timestampDate(policy.deletedAt),
  };
}
/** Saved policies affect subsequent requests from sessions that select them. */
export class SecretPolicies {
  constructor(
    private readonly workspaceId: string,
    private readonly rpc: Client<typeof pb.WorkspaceSecretsService>,
  ) {}
  async create(name: string, rules: SecretRequestRule[], requestId = randomUUID()): Promise<WorkspaceSecretPolicy> {
    try {
      return metadata(
        (await this.rpc.createSecretPolicy({ workspaceId: this.workspaceId, name, rules, requestId })).policy,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async update(
    policyId: string,
    rules: SecretRequestRule[],
    options: SecretMutationOptions,
  ): Promise<WorkspaceSecretPolicy> {
    try {
      return metadata(
        (
          await this.rpc.updateSecretPolicy({
            ...options,
            workspaceId: this.workspaceId,
            policyId,
            rules,
            requestId: options.requestId ?? randomUUID(),
          })
        ).policy,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async delete(policyId: string, options: SecretMutationOptions): Promise<WorkspaceSecretPolicy> {
    try {
      return metadata(
        (
          await this.rpc.deleteSecretPolicy({
            ...options,
            workspaceId: this.workspaceId,
            policyId,
            requestId: options.requestId ?? randomUUID(),
          })
        ).policy,
      );
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async get(nameOrId: string): Promise<WorkspaceSecretPolicy> {
    try {
      return metadata((await this.rpc.getSecretPolicy({ workspaceId: this.workspaceId, policyId: nameOrId })).policy);
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
  async list(options: SecretPageOptions = {}): Promise<{ policies: WorkspaceSecretPolicy[]; nextCursor: string }> {
    try {
      const page = await this.rpc.listSecretPolicies({ ...options, workspaceId: this.workspaceId });
      return { policies: page.policies.map(metadata), nextCursor: page.nextCursor };
    } catch (err) {
      throw workspaceSecretError(err);
    }
  }
}

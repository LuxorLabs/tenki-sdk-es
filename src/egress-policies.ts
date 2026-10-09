import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";

import {
  SessionEgressPolicySchema,
  type EgressPolicy as EgressPolicyMessage,
  type SessionEgressPolicy as SessionEgressPolicyMessage,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type { EgressHttpRule, WorkspaceScopeOptions } from "./options.js";
import { egressHttpRuleToProto, egressPolicyFromProto, type SessionEgressPolicy } from "./session.js";

/** The body of a named egress policy, checked by the server like an inline session policy. */
export interface EgressPolicySpec {
  allowDomains?: string[];
  allowCidrs?: string[];
  interceptHttps?: boolean;
  httpRules?: EgressHttpRule[];
}

/** A named workspace egress policy that sessions pin with `egressPolicies`. */
export interface EgressPolicy {
  id: string;
  workspaceId: string;
  name: string;
  revision: number;
  /** The stored policy; its policyNames is always empty. */
  egress: SessionEgressPolicy;
  /** Sessions not yet terminated that pinned this policy. */
  activeSessionCount: number;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date;
}

export function egressPolicySpecToProto(spec: EgressPolicySpec): SessionEgressPolicyMessage {
  return create(SessionEgressPolicySchema, {
    allowDomains: [...(spec.allowDomains ?? [])],
    allowCidrs: [...(spec.allowCidrs ?? [])],
    interceptHttps: spec.interceptHttps ?? false,
    httpRules: (spec.httpRules ?? []).map(egressHttpRuleToProto),
  });
}

export function egressPolicyFromMessage(policy: EgressPolicyMessage | undefined): EgressPolicy {
  if (!policy) throw new Error("Missing egress policy");
  return {
    id: policy.id,
    workspaceId: policy.workspaceId,
    name: policy.name,
    revision: policy.revision,
    egress: egressPolicyFromProto(policy.egress),
    activeSessionCount: policy.activeSessionCount,
    createdAt: policy.createdAt && timestampDate(policy.createdAt),
    updatedAt: policy.updatedAt && timestampDate(policy.updatedAt),
    deletedAt: policy.deletedAt && timestampDate(policy.deletedAt),
  };
}

export function workspaceScope(options?: WorkspaceScopeOptions): string | undefined {
  return options?.workspaceId?.trim() || undefined;
}

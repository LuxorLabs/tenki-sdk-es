import { create } from "@bufbuild/protobuf";

import {
  TailnetEphemeralPausePolicy as ProtoTailnetEphemeralPausePolicy,
  TailnetExitPolicy as ProtoTailnetExitPolicy,
  TailnetAttachmentSchema,
  type TailnetAttachment as ProtoTailnetAttachment,
  type TailnetStatus as ProtoTailnetStatus,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export type TailnetExitPolicy = "tenki_allowlist" | "exit_node_managed";
export type TailnetEphemeralPausePolicy = "reject" | "recreate_on_resume";
export type TailnetState = "pending" | "joining" | "online" | "offline" | "error" | "detached";
export type TailnetProvider = "tailscale";

const authKeyValues = new WeakMap<TailnetAuthKey, string>();
const inspect = Symbol.for("nodejs.util.inspect.custom");

export class TailnetAuthKey {
  constructor(value: string) {
    if (!value.trim()) throw new TypeError("tailnet auth key is required");
    authKeyValues.set(this, value);
    Object.freeze(this);
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [inspect](): string {
    return "TailnetAuthKey([REDACTED])";
  }
}

export interface TailnetAttachmentOptions {
  authKey?: TailnetAuthKey;
  profileId?: string;
  profileRevision?: number;
  provider?: TailnetProvider;
  hostname?: string;
  tags?: string[];
  ephemeral?: boolean;
  controlUrl?: string;
  exitNode?: string;
  acceptRoutes?: boolean;
  wakeOnConnect?: boolean;
  exposePorts?: number[];
  waitForOnline?: boolean;
  exitPolicy?: TailnetExitPolicy;
  ephemeralPausePolicy?: TailnetEphemeralPausePolicy;
}

export interface TailnetStatus {
  provider: string;
  state: TailnetState;
  nodeId: string;
  fqdn: string;
  ips: string[];
  tags: string[];
  owner: string;
  error: string;
  deviceRetained: boolean;
}

export function tailnetAttachmentToProto(options: TailnetAttachmentOptions): ProtoTailnetAttachment {
  const provider = options.provider ?? "tailscale";
  if (provider !== "tailscale") throw new TypeError("unsupported tailnet provider");
  let credential: ProtoTailnetAttachment["credential"];
  if (options.profileId) {
    if (options.authKey) throw new TypeError("provide one tailnet credential: authKey or profileId");
    credential = { case: "profileId", value: options.profileId };
  } else {
    if (!(options.authKey instanceof TailnetAuthKey)) throw new TypeError("tailnet authKey must be a TailnetAuthKey");
    const authKey = authKeyValues.get(options.authKey);
    if (!authKey) throw new TypeError("tailnet auth key is required");
    credential = { case: "authKey", value: authKey };
  }
  return create(TailnetAttachmentSchema, {
    provider,
    hostname: options.hostname ?? "",
    tags: [...(options.tags ?? [])],
    ephemeral: options.ephemeral ?? false,
    controlUrl: options.controlUrl ?? "",
    exitNode: options.exitNode ?? "",
    acceptRoutes: options.acceptRoutes ?? false,
    wakeOnConnect: options.wakeOnConnect ?? false,
    exposePorts: [...(options.exposePorts ?? [])],
    waitForOnline: options.waitForOnline ?? false,
    credential,
    profileRevision: options.profileRevision ?? 0,
    exitPolicy: exitPolicyToProto(options.exitPolicy),
    ephemeralPausePolicy: ephemeralPausePolicyToProto(options.ephemeralPausePolicy),
  });
}

export function tailnetStatusFromProto(status?: ProtoTailnetStatus): TailnetStatus | undefined {
  if (!status) return undefined;
  return {
    provider: status.provider || "tailscale",
    state: status.state as TailnetState,
    nodeId: status.nodeId,
    fqdn: status.fqdn,
    ips: [...status.ips],
    tags: [...status.tags],
    owner: status.owner,
    error: status.error,
    deviceRetained: status.deviceRetained,
  };
}

function exitPolicyToProto(policy: TailnetExitPolicy | undefined): ProtoTailnetExitPolicy {
  switch (policy) {
    case undefined:
      return ProtoTailnetExitPolicy.UNSPECIFIED;
    case "tenki_allowlist":
      return ProtoTailnetExitPolicy.TENKI_ALLOWLIST;
    case "exit_node_managed":
      return ProtoTailnetExitPolicy.EXIT_NODE_MANAGED;
    default:
      throw new TypeError("unsupported tailnet exit policy");
  }
}

function ephemeralPausePolicyToProto(
  policy: TailnetEphemeralPausePolicy | undefined,
): ProtoTailnetEphemeralPausePolicy {
  switch (policy) {
    case undefined:
      return ProtoTailnetEphemeralPausePolicy.UNSPECIFIED;
    case "reject":
      return ProtoTailnetEphemeralPausePolicy.REJECT;
    case "recreate_on_resume":
      return ProtoTailnetEphemeralPausePolicy.RECREATE_ON_RESUME;
    default:
      throw new TypeError("unsupported tailnet ephemeral pause policy");
  }
}

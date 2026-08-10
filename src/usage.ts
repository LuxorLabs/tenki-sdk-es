import { SandboxUsageUnit, type WorkspaceSandboxUsageLimit } from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

/** What a {@link WorkspaceUsageLimit}'s `current` / `max` are measured in. */
export type WorkspaceUsageUnit = "count" | "bytes" | "unspecified";

/**
 * One usage dimension for a workspace (e.g. concurrent sessions, snapshots),
 * with the current usage and the effective limit. Returned by
 * {@link TenkiSandbox.getUsage}.
 *
 * `current` reflects resources that hold live VMs — paused sessions are
 * excluded, matching how the concurrency quota is enforced on create.
 */
export interface WorkspaceUsageLimit {
  /** Stable usage key, e.g. `"max_concurrent_jobs"`. */
  key: string;
  /** Human-readable label, e.g. `"Active sessions"`. */
  label: string;
  /** What `current` / `max` are counted in. */
  unit: WorkspaceUsageUnit;
  /** Current usage. */
  current: number;
  /** The effective limit, or `undefined` when unlimited / not set. */
  max?: number;
  /** Explanatory help text from the backend. */
  helpText: string;
}

function usageUnitFromProto(unit: SandboxUsageUnit): WorkspaceUsageUnit {
  switch (unit) {
    case SandboxUsageUnit.COUNT:
      return "count";
    case SandboxUsageUnit.BYTES:
      return "bytes";
    default:
      return "unspecified";
  }
}

export function workspaceUsageLimitFromProto(limit: WorkspaceSandboxUsageLimit): WorkspaceUsageLimit {
  return {
    key: limit.key,
    label: limit.label,
    unit: usageUnitFromProto(limit.unit),
    current: Number(limit.current),
    max: limit.max === undefined ? undefined : Number(limit.max),
    helpText: limit.helpText,
  };
}

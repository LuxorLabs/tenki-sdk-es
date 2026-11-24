import { timestampDate } from "@bufbuild/protobuf/wkt";

import {
  SessionCostItem as ProtoSessionCostItem,
  SessionCostStatus as ProtoSessionCostStatus,
  SessionCostUnit as ProtoSessionCostUnit,
  type BatchGetSessionCostsResponse,
  type SessionCost as ProtoSessionCost,
  type SessionCostLine as ProtoSessionCostLine,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

/**
 * `ACCRUING`: metering is still running and amounts can grow. `FINAL`: the
 * session has ended and amounts will not change. `UNAVAILABLE`: the session
 * started before per-session cost tracking, so no amounts are reported.
 */
export type SessionCostStatus = "UNSPECIFIED" | "ACCRUING" | "FINAL" | "UNAVAILABLE";

/** `DISK` is disk above the included allowance; `PAUSED_STORAGE` is storage kept while paused. */
export type SessionCostItem = "UNSPECIFIED" | "CPU" | "MEMORY" | "DISK" | "PAUSED_STORAGE";

/** 1 GiB = 2^30 bytes. */
export type SessionCostUnit = "UNSPECIFIED" | "VCPU_SECOND" | "GIB_SECOND";

export interface SessionCostLine {
  item: SessionCostItem;
  /** Decimal quantity in `unit`, for example cores times seconds. */
  quantity: string;
  unit: SessionCostUnit;
  /** Decimal USD. */
  amountUsd: string;
  /** Start of the period that contains this line's usage. */
  startedAt?: Date;
  /** Unset while the cost is `ACCRUING`. */
  endedAt?: Date;
}

/** Returned by {@link TenkiSandbox.getSessionCost} and {@link Session.cost}. */
export interface SessionCost {
  sessionId: string;
  status: SessionCostStatus;
  /**
   * Decimal USD at list price before credits, the sum of `lines`. Unset while
   * `ACCRUING` with nothing metered yet; `"0"` means nothing was billed.
   */
  totalUsd?: string;
  lines: SessionCostLine[];
  /** Usage up to this time is counted. Unset until the first metering tick. */
  asOf?: Date;
  /** Whole seconds billed as running compute. */
  billedRunningSeconds: number;
  /** Whole seconds billed as paused storage. */
  billedPausedSeconds: number;
}

/** Returned by {@link TenkiSandbox.batchGetSessionCosts}. */
export interface SessionCostBatch {
  costs: SessionCost[];
  /** Requested sessions that are not in the workspace or not visible to the caller. */
  missingSessionIds: string[];
}

export function sessionCostFromProto(cost: ProtoSessionCost | undefined, sessionId = ""): SessionCost {
  return {
    sessionId: cost?.sessionId || sessionId,
    status: sessionCostStatusFromProto(cost?.status),
    totalUsd: cost?.totalUsd,
    lines: (cost?.lines ?? []).map(sessionCostLineFromProto),
    asOf: cost?.asOf ? timestampDate(cost.asOf) : undefined,
    billedRunningSeconds: Number(cost?.billedRunningSeconds ?? 0n),
    billedPausedSeconds: Number(cost?.billedPausedSeconds ?? 0n),
  };
}

export function sessionCostBatchFromProto(resp: BatchGetSessionCostsResponse): SessionCostBatch {
  return {
    costs: resp.costs.map((cost) => sessionCostFromProto(cost)),
    missingSessionIds: [...resp.missingSessionIds],
  };
}

function sessionCostLineFromProto(line: ProtoSessionCostLine): SessionCostLine {
  return {
    item: sessionCostItemFromProto(line.item),
    quantity: line.quantity,
    unit: sessionCostUnitFromProto(line.unit),
    amountUsd: line.amountUsd,
    startedAt: line.startedAt ? timestampDate(line.startedAt) : undefined,
    endedAt: line.endedAt ? timestampDate(line.endedAt) : undefined,
  };
}

function sessionCostStatusFromProto(status?: ProtoSessionCostStatus): SessionCostStatus {
  switch (status) {
    case ProtoSessionCostStatus.ACCRUING:
      return "ACCRUING";
    case ProtoSessionCostStatus.FINAL:
      return "FINAL";
    case ProtoSessionCostStatus.UNAVAILABLE:
      return "UNAVAILABLE";
    default:
      return "UNSPECIFIED";
  }
}

function sessionCostItemFromProto(item: ProtoSessionCostItem): SessionCostItem {
  switch (item) {
    case ProtoSessionCostItem.CPU:
      return "CPU";
    case ProtoSessionCostItem.MEMORY:
      return "MEMORY";
    case ProtoSessionCostItem.DISK:
      return "DISK";
    case ProtoSessionCostItem.PAUSED_STORAGE:
      return "PAUSED_STORAGE";
    default:
      return "UNSPECIFIED";
  }
}

function sessionCostUnitFromProto(unit: ProtoSessionCostUnit): SessionCostUnit {
  switch (unit) {
    case ProtoSessionCostUnit.VCPU_SECOND:
      return "VCPU_SECOND";
    case ProtoSessionCostUnit.GIB_SECOND:
      return "GIB_SECOND";
    default:
      return "UNSPECIFIED";
  }
}

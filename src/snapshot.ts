import { timestampDate } from "@bufbuild/protobuf/wkt";

import type { Snapshot as ProtoSnapshot } from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  SnapshotState as ProtoSnapshotState,
  SnapshotType as ProtoSnapshotType,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export type SnapshotState = "UNSPECIFIED" | "CREATING" | "READY" | "FAILED" | "DELETING" | "DELETED";
export type SnapshotType = "UNSPECIFIED" | "USER" | "PAUSE" | "TEMPLATE";

export interface SnapshotDownloadURL {
  url: string;
  expiresAt?: Date;
}

export interface Snapshot {
  id: string;
  sessionId: string;
  workspaceId: string;
  name: string;
  state: SnapshotState;
  sizeBytes: number;
  compressedBytes: number;
  memoryBytes: number;
  baseImageId: string;
  createdAt: Date;
  expiresAt?: Date;
  tags: string[];
  type: SnapshotType;
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
  rawImageAvailable: boolean;
  readonly hasRuntimeSecrets: boolean;
  /** Set when state is FAILED. */
  failureReason?: string;
}

export function snapshotStateFromProto(state: ProtoSnapshotState): SnapshotState {
  switch (state) {
    case ProtoSnapshotState.CREATING:
      return "CREATING";
    case ProtoSnapshotState.READY:
      return "READY";
    case ProtoSnapshotState.FAILED:
      return "FAILED";
    case ProtoSnapshotState.DELETING:
      return "DELETING";
    case ProtoSnapshotState.DELETED:
      return "DELETED";
    default:
      return "UNSPECIFIED";
  }
}

export function snapshotIsReady(state: SnapshotState): boolean {
  return state === "READY";
}

export function snapshotIsTerminal(state: SnapshotState): boolean {
  return state === "FAILED" || state === "DELETED";
}

export function snapshotTypeFromProto(type: ProtoSnapshotType): SnapshotType {
  switch (type) {
    case ProtoSnapshotType.USER:
      return "USER";
    case ProtoSnapshotType.PAUSE:
      return "PAUSE";
    case ProtoSnapshotType.TEMPLATE:
      return "TEMPLATE";
    default:
      return "UNSPECIFIED";
  }
}

export function snapshotFromProto(proto: ProtoSnapshot): Snapshot {
  return {
    id: proto.id,
    sessionId: proto.sessionId,
    workspaceId: proto.workspaceId ?? "",
    name: proto.name ?? "",
    state: snapshotStateFromProto(proto.state),
    sizeBytes: Number(proto.sizeBytes),
    compressedBytes: Number(proto.compressedBytes),
    memoryBytes: Number(proto.memoryBytes),
    baseImageId: proto.baseImageId,
    createdAt: proto.createdAt ? timestampDate(proto.createdAt) : new Date(0),
    expiresAt: proto.expiresAt ? timestampDate(proto.expiresAt) : undefined,
    tags: [...(proto.tags ?? [])],
    type: snapshotTypeFromProto(proto.type),
    cpuCores: proto.cpuCores,
    memoryMb: proto.memoryMb,
    diskSizeGb: proto.diskSizeGb,
    rawImageAvailable: proto.rawImageAvailable,
    hasRuntimeSecrets: proto.hasRuntimeSecrets,
    failureReason: proto.failureReason || undefined,
  };
}

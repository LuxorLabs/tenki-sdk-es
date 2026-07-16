import type {
  Volume as ProtoVolume,
  VolumeAttachment as ProtoVolumeAttachment,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { VolumeState as ProtoVolumeState } from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export type VolumeState = "UNSPECIFIED" | "AVAILABLE" | "DELETING" | "DELETED";

export interface VolumeAttachment {
  id: string;
  volumeId: string;
  sessionId: string;
  mountPath: string;
  readOnly: boolean;
  state: string;
}

export interface Volume {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  sizeBytes: number;
  state: VolumeState;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  activeAttachments?: VolumeAttachment[];
}

export function volumeStateFromProto(state: ProtoVolumeState): VolumeState {
  switch (state) {
    case ProtoVolumeState.AVAILABLE:
      return "AVAILABLE";
    case ProtoVolumeState.DELETING:
      return "DELETING";
    case ProtoVolumeState.DELETED:
      return "DELETED";
    default:
      return "UNSPECIFIED";
  }
}

export function volumeIsReady(state: VolumeState): boolean {
  return state === "AVAILABLE";
}

export function volumeIsTerminal(state: VolumeState): boolean {
  return state === "DELETED";
}

export function volumeIsDeletable(v: Volume): boolean {
  return volumeIsReady(v.state) && (v.activeAttachments ?? []).length === 0;
}

function parseTime(raw: string): Date {
  if (!raw.trim()) return new Date(0);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function volumeAttachmentFromProto(a: ProtoVolumeAttachment): VolumeAttachment {
  return {
    id: a.id,
    volumeId: a.volumeId,
    sessionId: a.sessionId,
    mountPath: a.mountPath,
    readOnly: a.readonly,
    state: a.state,
  };
}

export function volumeFromProto(proto: ProtoVolume, activeAttachments?: ProtoVolumeAttachment[]): Volume {
  return {
    id: proto.id,
    workspaceId: proto.workspaceId,
    projectId: proto.projectId,
    name: proto.name,
    sizeBytes: Number(proto.sizeBytes),
    state: volumeStateFromProto(proto.state),
    createdAt: parseTime(proto.createdAt),
    updatedAt: parseTime(proto.updatedAt),
    tags: [...(proto.tags ?? [])],
    activeAttachments: (activeAttachments ?? []).map(volumeAttachmentFromProto),
  };
}

import { timestampDate } from "@bufbuild/protobuf/wkt";

import type {
  Template as ProtoTemplate,
  TemplateBuild as ProtoTemplateBuild,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  TemplateBuildState as ProtoTemplateBuildState,
  TemplateVisibility as ProtoTemplateVisibility,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export type TemplateBuildState = "UNSPECIFIED" | "PENDING" | "BUILDING" | "READY" | "FAILED";

export interface TemplateResources {
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
}

export interface TemplateBuild {
  id: string;
  templateId: string;
  state: TemplateBuildState;
  version: number;
  error: string;
  buildLogTail: string;
  buildLogTruncated: boolean;
  buildLogArtifactId: string;
  startedAt: Date;
  completedAt: Date;
  snapshotId: string;
  sessionId: string;
}

export type TemplateVisibility = "UNSPECIFIED" | "PRIVATE" | "PUBLIC";

export interface Template {
  id: string;
  workspaceId: string;
  projectId: string;
  ownerType: string;
  ownerId: string;
  name: string;
  baseImageId: string;
  setupScript: string;
  startCmd: string;
  envVars: Record<string, string>;
  tags: string[];
  resources?: TemplateResources;
  latestBuild?: TemplateBuild;
  visibility: TemplateVisibility;
  parentWorkspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export function templateBuildStateFromProto(state: ProtoTemplateBuildState): TemplateBuildState {
  switch (state) {
    case ProtoTemplateBuildState.PENDING:
      return "PENDING";
    case ProtoTemplateBuildState.BUILDING:
      return "BUILDING";
    case ProtoTemplateBuildState.READY:
      return "READY";
    case ProtoTemplateBuildState.FAILED:
      return "FAILED";
    default:
      return "UNSPECIFIED";
  }
}

export function templateBuildFromProto(proto: ProtoTemplateBuild | undefined): TemplateBuild | undefined {
  if (!proto) return undefined;
  return {
    id: proto.id,
    templateId: proto.templateId,
    state: templateBuildStateFromProto(proto.state),
    version: proto.version,
    error: proto.error ?? "",
    buildLogTail: proto.buildLogTail ?? "",
    buildLogTruncated: proto.buildLogTruncated,
    buildLogArtifactId: proto.buildLogArtifactId ?? "",
    startedAt: proto.startedAt ? timestampDate(proto.startedAt) : new Date(0),
    completedAt: proto.completedAt ? timestampDate(proto.completedAt) : new Date(0),
    snapshotId: proto.snapshotId ?? "",
    sessionId: proto.sessionId ?? "",
  };
}

export function templateVisibilityFromProto(state: ProtoTemplateVisibility): TemplateVisibility {
  switch (state) {
    case ProtoTemplateVisibility.PRIVATE:
      return "PRIVATE";
    case ProtoTemplateVisibility.PUBLIC:
      return "PUBLIC";
    default:
      return "UNSPECIFIED";
  }
}

export function templateFromProto(proto: ProtoTemplate): Template {
  return {
    id: proto.id,
    workspaceId: proto.workspaceId,
    projectId: proto.projectId,
    ownerType: proto.ownerType,
    ownerId: proto.ownerId,
    name: proto.name,
    baseImageId: proto.baseImageId,
    setupScript: proto.setupScript,
    startCmd: proto.startCmd ?? "",
    envVars: { ...proto.envVars },
    tags: [...(proto.tags ?? [])],
    resources: proto.resources
      ? {
          cpuCores: proto.resources.cpuCores,
          memoryMb: proto.resources.memoryMb,
          diskSizeGb: proto.resources.diskSizeGb,
        }
      : undefined,
    latestBuild: templateBuildFromProto(proto.latestBuild),
    visibility: templateVisibilityFromProto(proto.visibility),
    parentWorkspaceId: proto.parentWorkspaceId ?? "",
    createdAt: proto.createdAt ? timestampDate(proto.createdAt) : new Date(0),
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : new Date(0),
  };
}

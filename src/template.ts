import { timestampDate } from "@bufbuild/protobuf/wkt";

import type { RegistryImage as ProtoRegistryImage } from "./internal/proto/tenki/sandbox/v1/registry_pb.js";
import type {
  Template as ProtoTemplate,
  TemplateBuild as ProtoTemplateBuild,
  TemplateBuildEvent as ProtoTemplateBuildEvent,
  TemplateBuildStepReference as ProtoTemplateBuildStepReference,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import {
  TemplateBuildState as ProtoTemplateBuildState,
  TemplateDefinitionMode as ProtoTemplateDefinitionMode,
  TemplateVisibility as ProtoTemplateVisibility,
  TemplateBuildLogStream,
  TemplateBuildProgressState,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import type { RegistryImage } from "./registry.js";
import { registryImageFromProto } from "./registry.js";
import { TemplateSpec } from "./template-spec.js";

export type TemplateBuildState = "UNSPECIFIED" | "PENDING" | "BUILDING" | "READY" | "FAILED";

export interface TemplateResources {
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
}

/** Private registry image produced by a successful template build. */
export interface TemplateImage extends RegistryImage {
  /** Untagged ref tracking the latest eligible successful build. */
  ref: string;
  /** Immutable SHA-256 image manifest digest. */
  digest: string;
  /** Immutable digest-addressed ref, e.g. "acme/node-api@sha256:...". */
  digestRef: string;
}

/** Accepted by create({ image }); a TemplateImage satisfies it. */
export interface TemplateImageRef {
  ref?: string;
  digestRef?: string;
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
  /** Frozen typed spec this build executes; immutable once submitted. */
  spec?: TemplateSpec;
  /** Server-computed hash of the normalized spec. */
  specHash: string;
  /** Present once the build succeeds. */
  image?: TemplateImage;
  imageDigest: string;
  imageDigestRef: string;
  events: TemplateBuildEvent[];
  provenance?: TemplateBuildProvenance;
  failure?: TemplateBuildFailure;
}

export interface TemplateBuildStepReference {
  index: number;
  kind: string;
  name?: string;
  label: string;
}

interface TemplateBuildEventBase {
  timestamp: Date;
  phase: string;
  step?: TemplateBuildStepReference;
}

export interface TemplateBuildLogEvent extends TemplateBuildEventBase {
  type: "log";
  stream: "stdout" | "stderr" | "system";
  data: string;
}

export interface TemplateBuildProgressEvent extends TemplateBuildEventBase {
  type: "progress";
  state: "unspecified" | "started" | "completed" | "failed";
  message?: string;
}

export type TemplateBuildEvent = TemplateBuildLogEvent | TemplateBuildProgressEvent;

export interface TemplateBuildWaitOptions {
  signal?: AbortSignal;
  onEvent?: (event: TemplateBuildEvent) => void | Promise<void>;
}

export interface TemplateBuildOptions extends TemplateBuildWaitOptions {
  /** Request-scoped environment overrides frozen into this build. */
  buildEnv?: Record<string, string>;
  /** Ephemeral environment variables available only during this build. */
  buildSecrets?: Record<string, string>;
  publishRawImage?: boolean;
  waitForCompletion?: boolean;
}

export interface TemplateBuildProvenance {
  requestedGitRef?: string;
  resolvedGitCommitSha?: string;
  buildSecretKeys?: string[];
}

export interface TemplateBuildFailure {
  code: string;
  message: string;
  step?: TemplateBuildStepReference;
}

export type TemplateVisibility = "UNSPECIFIED" | "PRIVATE" | "PUBLIC";
export type TemplateDefinitionMode = "UNSPECIFIED" | "LEGACY" | "TYPED";

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
  /** Typed v1 recipe when the template is spec-backed. */
  spec?: TemplateSpec;
  /** Server-computed hash of the normalized spec. */
  specHash: string;
  latestBuild?: TemplateBuild;
  visibility: TemplateVisibility;
  definitionMode: TemplateDefinitionMode;
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
    spec: proto.builderSpec ? TemplateSpec.fromProto(proto.builderSpec) : undefined,
    specHash: proto.specHash ?? "",
    image: templateImageFromProto(proto.image, proto.imageDigest, proto.imageDigestRef),
    imageDigest: proto.imageDigest ?? "",
    imageDigestRef: proto.imageDigestRef ?? "",
    events: proto.events.flatMap(templateBuildEventFromProto),
    provenance: proto.provenance
      ? {
          requestedGitRef: proto.provenance.requestedGitRef,
          resolvedGitCommitSha: proto.provenance.resolvedGitCommitSha,
          buildSecretKeys: [...proto.provenance.buildSecretKeys],
        }
      : undefined,
    failure: proto.failure
      ? {
          code: proto.failure.code,
          message: proto.failure.message,
          step: templateBuildStepFromProto(proto.failure.step),
        }
      : undefined,
  };
}

function templateImageFromProto(
  proto: ProtoRegistryImage | undefined,
  digest: string | undefined,
  digestRef: string | undefined,
): TemplateImage | undefined {
  if (!proto) return undefined;
  const image = registryImageFromProto(proto);
  return {
    ...image,
    ref: [image.workspaceSlug, image.name].filter(Boolean).join("/"),
    digest: digest ?? "",
    digestRef: digestRef ?? "",
  };
}

function templateBuildStepFromProto(
  step: ProtoTemplateBuildStepReference | undefined,
): TemplateBuildStepReference | undefined {
  return step ? { index: step.index, kind: step.kind, name: step.name, label: step.label } : undefined;
}

function templateBuildEventFromProto(event: ProtoTemplateBuildEvent): TemplateBuildEvent[] {
  if (event.event.case === "log") {
    const value = event.event.value;
    const stream =
      value.stream === TemplateBuildLogStream.STDOUT
        ? "stdout"
        : value.stream === TemplateBuildLogStream.STDERR
          ? "stderr"
          : "system";
    return [
      {
        type: "log",
        timestamp: value.timestamp ? timestampDate(value.timestamp) : new Date(0),
        phase: value.phase,
        step: templateBuildStepFromProto(value.step),
        stream,
        data: value.data,
      },
    ];
  }
  if (event.event.case === "progress") {
    const value = event.event.value;
    const state =
      value.state === TemplateBuildProgressState.STARTED
        ? "started"
        : value.state === TemplateBuildProgressState.COMPLETED
          ? "completed"
          : value.state === TemplateBuildProgressState.FAILED
            ? "failed"
            : "unspecified";
    return [
      {
        type: "progress",
        timestamp: value.timestamp ? timestampDate(value.timestamp) : new Date(0),
        phase: value.phase,
        step: templateBuildStepFromProto(value.step),
        state,
        message: value.message,
      },
    ];
  }
  return [];
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

export function templateDefinitionModeFromProto(state: ProtoTemplateDefinitionMode): TemplateDefinitionMode {
  switch (state) {
    case ProtoTemplateDefinitionMode.LEGACY:
      return "LEGACY";
    case ProtoTemplateDefinitionMode.TYPED:
      return "TYPED";
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
    spec: proto.builderSpec ? TemplateSpec.fromProto(proto.builderSpec) : undefined,
    specHash: proto.specHash ?? "",
    latestBuild: templateBuildFromProto(proto.latestBuild),
    visibility: templateVisibilityFromProto(proto.visibility),
    definitionMode: templateDefinitionModeFromProto(proto.definitionMode),
    parentWorkspaceId: proto.parentWorkspaceId ?? "",
    createdAt: proto.createdAt ? timestampDate(proto.createdAt) : new Date(0),
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : new Date(0),
  };
}

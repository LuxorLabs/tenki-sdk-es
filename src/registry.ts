import { toJson } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";

import type {
  RegistryImage as ProtoRegistryImage,
  RegistryImageDetail as ProtoRegistryImageDetail,
  RegistryImageSummary as ProtoRegistryImageSummary,
  RegistryShareGrant as ProtoRegistryShareGrant,
  RegistryTag as ProtoRegistryTag,
  ResolvedRegistryRef as ProtoResolvedRegistryRef,
} from "./internal/proto/tenki/sandbox/v1/registry_pb.js";
import {
  RegistryImageKind as ProtoRegistryImageKind,
  RegistrySortBy as ProtoRegistrySortBy,
  RegistryVisibility as ProtoRegistryVisibility,
} from "./internal/proto/tenki/sandbox/v1/registry_pb.js";
import { RuntimeSecretFileSchema } from "./internal/proto/tenki/sandbox/v1/secret_file_pb.js";
import type { RuntimeSecretFile } from "./secret-files.js";

export type RegistryImageKind = "template" | "snapshot";
export type RegistryVisibility = "private" | "public" | "shared";
export type RegistrySortBy = "updated_at" | "name";

export interface RegistryTag {
  id: string;
  imageId: string;
  tag: string;
  snapshotId: string;
  ref: string;
  updatedAt: Date;
}

export interface RegistryImage {
  id: string;
  /** Empty for a system image, which belongs to a namespace rather than a workspace. */
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  kind: RegistryImageKind;
  visibility: RegistryVisibility;
  title?: string;
  description?: string;
  labels: string[];
  sourceTemplateId?: string;
  sourceSnapshotId?: string;
  tags: RegistryTag[];
  createdAt: Date;
  updatedAt: Date;
  changesNotYetPublished: boolean;
}

export interface RegistryImageSummary {
  id: string;
  /** Empty for a system image, which belongs to a namespace rather than a workspace. */
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  kind: RegistryImageKind;
  visibility: RegistryVisibility;
  labels: string[];
  tags: RegistryTag[];
  latestSnapshotId?: string;
  latestRef: string;
  updatedAt: Date;
  changesNotYetPublished: boolean;
}

export interface RegistryImageDetail {
  runtimeSecretEnv: Record<string, string>;
  runtimeSecretPolicies: string[];
  runtimeSecretFiles: RuntimeSecretFile[];
  image?: RegistryImage;
  resolvedSnapshotId?: string;
  resolvedRef?: string;
  workspaceActive: boolean;
  tombstoned: boolean;
  maskedEnvVarKeys: string[];
  metadata: Record<string, string>;
  envVars: Record<string, string>;
}

export interface RegistryShareGrant {
  id: string;
  imageId: string;
  ownerWorkspaceId: string;
  targetWorkspaceId: string;
  currentSnapshotId: string;
  grantedViaTokenId?: string;
  acceptedBy?: string;
  acceptedAt: Date;
  revokedAt?: Date;
  followMode: string;
  followTag?: string;
}

export interface ResolvedRegistryRef {
  imageId: string;
  owningWorkspaceId: string;
  owningWorkspaceSlug: string;
  imageName: string;
  snapshotId?: string;
  resolvedRef: string;
  kind: RegistryImageKind;
  visibility: RegistryVisibility;
}

export interface RegistryPublishResult {
  image?: RegistryImage;
  tag?: RegistryTag;
  snapshotId: string;
  digestRef: string;
}

export interface RegistryListResult {
  images: RegistryImageSummary[];
  nextCursor: string;
}

export interface RegistryShareResult {
  image?: RegistryImage;
  currentSnapshotId: string;
  digestRef: string;
  grant?: RegistryShareGrant;
}

export interface RegistryUnshareResult {
  image?: RegistryImage;
  revokedTokenCount: number;
  revokedGrantCount: number;
}

export interface RegistryDeleteResult {
  image?: RegistryImage;
  revokedTokenCount: number;
  revokedGrantCount: number;
}

export interface RegistryVersionDeleteResult {
  imageId: string;
  snapshotId: string;
}

export function registryKindFromProto(kind: ProtoRegistryImageKind): RegistryImageKind {
  switch (kind) {
    case ProtoRegistryImageKind.SNAPSHOT:
      return "snapshot";
    case ProtoRegistryImageKind.TEMPLATE:
    default:
      return "template";
  }
}

export function registryKindToProto(kind: RegistryImageKind): ProtoRegistryImageKind {
  switch (kind) {
    case "snapshot":
      return ProtoRegistryImageKind.SNAPSHOT;
    case "template":
      return ProtoRegistryImageKind.TEMPLATE;
  }
}

export function registryVisibilityFromProto(visibility: ProtoRegistryVisibility): RegistryVisibility {
  switch (visibility) {
    case ProtoRegistryVisibility.PUBLIC:
      return "public";
    case ProtoRegistryVisibility.SHARED:
      return "shared";
    case ProtoRegistryVisibility.PRIVATE:
    default:
      return "private";
  }
}

export function registryVisibilityToProto(visibility: RegistryVisibility): ProtoRegistryVisibility {
  switch (visibility) {
    case "public":
      return ProtoRegistryVisibility.PUBLIC;
    case "shared":
      return ProtoRegistryVisibility.SHARED;
    case "private":
      return ProtoRegistryVisibility.PRIVATE;
  }
}

export function registrySortToProto(sort: RegistrySortBy): ProtoRegistrySortBy {
  switch (sort) {
    case "name":
      return ProtoRegistrySortBy.NAME;
    case "updated_at":
      return ProtoRegistrySortBy.UPDATED_AT;
  }
}

export function registryTagFromProto(proto: ProtoRegistryTag | undefined): RegistryTag | undefined {
  if (!proto) return undefined;
  return {
    id: proto.id,
    imageId: proto.imageId,
    tag: proto.tag,
    snapshotId: proto.snapshotId,
    ref: proto.ref,
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : new Date(0),
  };
}

export function registryImageFromProto(proto: ProtoRegistryImage): RegistryImage {
  return {
    id: proto.id,
    workspaceId: proto.workspaceId ?? "",
    workspaceSlug: proto.workspaceSlug,
    name: proto.name,
    kind: registryKindFromProto(proto.kind),
    visibility: registryVisibilityFromProto(proto.visibility),
    title: proto.title,
    description: proto.description,
    labels: [...(proto.labels ?? [])],
    sourceTemplateId: proto.sourceTemplateId,
    sourceSnapshotId: proto.sourceSnapshotId,
    tags: (proto.tags ?? []).map((tag) => registryTagFromProto(tag)!),
    createdAt: proto.createdAt ? timestampDate(proto.createdAt) : new Date(0),
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : new Date(0),
    changesNotYetPublished: proto.changesNotYetPublished,
  };
}

export function registryImageSummaryFromProto(proto: ProtoRegistryImageSummary): RegistryImageSummary {
  return {
    id: proto.id,
    workspaceId: proto.workspaceId ?? "",
    workspaceSlug: proto.workspaceSlug,
    name: proto.name,
    kind: registryKindFromProto(proto.kind),
    visibility: registryVisibilityFromProto(proto.visibility),
    labels: [...(proto.labels ?? [])],
    tags: (proto.tags ?? []).map((tag) => registryTagFromProto(tag)!),
    latestSnapshotId: proto.latestSnapshotId,
    latestRef: proto.latestRef,
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : new Date(0),
    changesNotYetPublished: proto.changesNotYetPublished,
  };
}

export function registryImageDetailFromProto(proto: ProtoRegistryImageDetail | undefined): RegistryImageDetail {
  return {
    image: proto?.image ? registryImageFromProto(proto.image) : undefined,
    runtimeSecretEnv: { ...(proto?.runtimeSecretEnv ?? {}) },
    runtimeSecretPolicies: [...(proto?.runtimeSecretPolicies ?? [])],
    runtimeSecretFiles: (proto?.runtimeSecretFiles ?? []).map(
      (file) => toJson(RuntimeSecretFileSchema, file) as unknown as RuntimeSecretFile,
    ),
    resolvedSnapshotId: proto?.resolvedSnapshotId,
    resolvedRef: proto?.resolvedRef,
    workspaceActive: proto?.workspaceActive ?? false,
    tombstoned: proto?.tombstoned ?? false,
    maskedEnvVarKeys: [...(proto?.maskedEnvVarKeys ?? [])],
    metadata: { ...(proto?.metadata ?? {}) },
    envVars: { ...(proto?.envVars ?? {}) },
  };
}

export function resolvedRegistryRefFromProto(proto: ProtoResolvedRegistryRef | undefined): ResolvedRegistryRef {
  return {
    imageId: proto?.imageId ?? "",
    owningWorkspaceId: proto?.owningWorkspaceId ?? "",
    owningWorkspaceSlug: proto?.owningWorkspaceSlug ?? "",
    imageName: proto?.imageName ?? "",
    snapshotId: proto?.snapshotId,
    resolvedRef: resolvedRegistryRefImage(proto),
    kind: registryKindFromProto(proto?.kind ?? ProtoRegistryImageKind.UNSPECIFIED),
    visibility: registryVisibilityFromProto(proto?.visibility ?? ProtoRegistryVisibility.UNSPECIFIED),
  };
}

export function registryShareGrantFromProto(
  proto: ProtoRegistryShareGrant | undefined,
): RegistryShareGrant | undefined {
  if (!proto) return undefined;
  return {
    id: proto.id,
    imageId: proto.imageId,
    ownerWorkspaceId: proto.ownerWorkspaceId,
    targetWorkspaceId: proto.targetWorkspaceId,
    currentSnapshotId: proto.currentSnapshotId,
    grantedViaTokenId: proto.grantedViaTokenId,
    acceptedBy: proto.acceptedBy,
    acceptedAt: proto.acceptedAt ? timestampDate(proto.acceptedAt) : new Date(0),
    revokedAt: proto.revokedAt ? timestampDate(proto.revokedAt) : undefined,
    followMode: proto.followMode,
    followTag: proto.followTag,
  };
}

function resolvedRegistryRefImage(proto: ProtoResolvedRegistryRef | undefined): string {
  if (!proto) return "";
  const base = `${proto.owningWorkspaceSlug}/${proto.imageName}`;
  if (proto.tag) return `${base}:${proto.tag}`;
  if (proto.snapshotId) return `${base}@${proto.snapshotId}`;
  return base;
}

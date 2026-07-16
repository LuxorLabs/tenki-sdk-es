import type { Buffer } from "node:buffer";
import type { Transport } from "@connectrpc/connect";

import type { RegistryImageKind, RegistrySortBy, RegistryVisibility } from "./registry.js";
import type { TemplateSpec } from "./template-spec.js";
import type { TemplateImageRef } from "./template.js";

export type RootCertificates = string | Buffer | Array<string | Buffer>;

export interface ClientOptions {
  authToken?: string;
  baseUrl?: string;
  /** Optional SSH gateway address override. Most users should omit it. */
  gatewayAddress?: string;
  cookieName?: string;
  rootCertificates?: RootCertificates;
  timeoutMs?: number;
  dataPlaneReadyTimeoutMs?: number;
  transport?: Transport;
}

export interface VolumeMountConfig {
  volumeId: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface CreateOptions {
  name?: string;
  allowInbound?: boolean;
  allowOutbound?: boolean;
  maxDurationMs?: number;
  idleTimeoutMinutes?: number;
  pauseRetentionMs?: number;
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;
  metadata?: Record<string, string>;
  tags?: string[];
  env?: Record<string, string>;
  /** Public keys installed in the sandbox; Tenki gateway auth also requires issueSandboxSSHCert. */
  sshAuthorizedKeys?: string[];
  /** Registry ref string, or an image object (e.g. build.image); digestRef wins over ref. */
  image?: string | TemplateImageRef;
  snapshotId?: string;
  workspaceId?: string;
  projectId?: string;
  enableOpenCode?: boolean;
  cloneRepoUrl?: string;
  volumes?: VolumeMountConfig[];
  openCodeProvider?: OpenCodeProviderConfig;
  githubToken?: string;
  sticky?: boolean;
  /** Wait until RUNNING with data-plane fields primed before returning. Defaults to true. */
  waitReady?: boolean;
  /** Overrides how long create waits for readiness. Defaults to 3 minutes. */
  waitTimeoutMs?: number;
  /** Wait until an image boot runtime is READY or FAILED. */
  waitForRuntime?: boolean;
}

export interface OpenCodeProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  npm?: string;
}

export interface ExecOptions {
  args?: string[];
  /** Guest working directory. Relative paths resolve under the sandbox guest workdir; absolute paths pass through. */
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  onOutput?: (output: Output) => void;
  signal?: AbortSignal;
}

export interface Output {
  data: Uint8Array;
  isStderr: boolean;
  isFinal: boolean;
}

export interface ExposePortOptions {
  ttlMs?: number;
  slug?: string;
}

export interface DetachVolumeOptions {
  force?: boolean;
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface CreateSnapshotOptions {
  name?: string;
  expiresAt?: Date;
}

export interface UpdateSessionOptions {
  name?: string;
  tags?: string[];
  sticky?: boolean;
  // Desired session lifetime to apply when un-stickying (sticky = false), so
  // "allow sleep" restores the caller's configured duration instead of the
  // server-side ceiling. Ignored by the backend unless sticky is set to false.
  maxDurationMs?: number;
}

export interface UpdateSnapshotOptions {
  name?: string;
  expiresAt?: Date;
  clearExpiresAt?: boolean;
  tags?: string[];
}

export interface CreateVolumeOptions {
  workspaceId: string;
  name: string;
  sizeBytes: number;
  projectId?: string;
}

export interface UpdateVolumeOptions {
  name?: string;
  tags?: string[];
}

export interface CreateTemplateOptions {
  workspaceId: string;
  name: string;
  /** Typed v1 recipe; cannot be combined with the legacy fields below. */
  spec?: TemplateSpec;
  baseImageId?: string;
  setupScript?: string;
  startCmd?: string;
  env?: Record<string, string>;
  tags?: string[];
  projectId?: string;
  resources?: { cpuCores?: number; memoryMb?: number; diskSizeGb?: number };
  parentTemplateId?: string;
  parentImage?: string;
}

export interface UpdateTemplateOptions {
  name?: string;
  /** Atomic full replacement of the typed recipe; cannot be combined with legacy fields. */
  spec?: TemplateSpec;
  baseImageId?: string;
  setupScript?: string;
  startCmd?: string;
  env?: Record<string, string>;
  tags?: string[];
  resources?: { cpuCores?: number; memoryMb?: number; diskSizeGb?: number };
}

export interface ListOptions {
  tags?: string[];
  sticky?: boolean;
}

export interface RegistryListOptions {
  workspace?: string;
  labels?: string[];
  kind?: RegistryImageKind;
  nameSubstring?: string;
  sort?: RegistrySortBy;
  pageSize?: number;
  cursor?: string;
}

export interface RegistryLookupOptions {
  workspaceId?: string;
}

export interface RegistryPublishOptions {
  image?: string;
  imageId?: string;
  workspaceId?: string;
  name?: string;
  fromTemplateId?: string;
  fromSnapshotId?: string;
  tag?: string;
  visibility?: RegistryVisibility;
  labels?: string[];
  title?: string;
  description?: string;
}

export interface RegistryShareOptions {
  targetWorkspaceId?: string;
  tag?: string;
  snapshotId?: string;
}

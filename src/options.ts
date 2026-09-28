import type { Buffer } from "node:buffer";
import type { Transport } from "@connectrpc/connect";

import type { RegistryImageKind, RegistrySortBy, RegistryVisibility } from "./registry.js";
import type { RuntimeSecretFile } from "./secret-files.js";
import type { SecretHeaderBinding } from "./secret-headers.js";
import type { TemplateSpec } from "./template-spec.js";
import type { Template, TemplateImageRef } from "./template.js";
import type { WarningHandler } from "./warning.js";

export type RootCertificates = string | Buffer | Array<string | Buffer>;

export interface ClientOptions {
  authToken?: string;
  /** Alias for authToken. Pass one or the other, not both. */
  apiKey?: string;
  baseUrl?: string;
  /** Optional SSH gateway address override. Most users should omit it. */
  gatewayAddress?: string;
  rootCertificates?: RootCertificates;
  timeoutMs?: number;
  dataPlaneReadyTimeoutMs?: number;
  /** Receives each warning returned by create(). Pass null to suppress emission. */
  warningHandler?: WarningHandler | null;
  transport?: Transport;
}

export interface VolumeMountConfig {
  volumeId: string;
  mountPath: string;
  readOnly?: boolean;
  /** Attachment state returned for existing sessions; ignored when creating a session. */
  state?: string;
}

export interface CreateOptions {
  /** Explicit scope for trusted service credentials; Workspace API keys infer it. */
  workspaceId?: string;
  name?: string;
  allowInbound?: boolean;
  allowOutbound?: boolean;
  /** Restricts outbound access to these domains (exact host or a single leading "*." wildcard). No effect if allowOutbound is false. */
  allowDomains?: string[];
  /** Restricts outbound access to these IPv4 CIDRs. No effect if allowOutbound is false. */
  allowCidrs?: string[];
  maxDurationMs?: number;
  /**
   * Ignored: sandboxes do not auto-pause on idle.
   * @deprecated Removed in the next major release; use maxDurationMs instead.
   */
  idleTimeoutMinutes?: number;
  pauseRetentionMs?: number;
  cpuCores?: number;
  memoryMb?: number;
  /**
   * Ephemeral root disk in GB, 5-100. A create with no image, snapshot or template
   * spec defaults to 5; one with a source inherits that source's disk unless set.
   */
  diskSizeGb?: number;
  metadata?: Record<string, string>;
  tags?: string[];
  env?: Record<string, string>;
  /** Public keys installed in the sandbox; Tenki gateway auth also requires issueSandboxSSHCert. */
  sshAuthorizedKeys?: string[];
  /** Registry ref string, or an image object (e.g. build.image); digestRef wins over ref. */
  image?: string | TemplateImageRef;
  snapshotId?: string;
  /** Execute the current typed template spec directly without publishing an image. */
  fromTemplateSpec?: string | Template;
  /** Non-secret environment used only during template checkout/setup. */
  setupEnv?: Record<string, string>;
  /** Secret environment used only during template checkout/setup. */
  setupSecrets?: Record<string, string>;
  /** Managed boot runtime authored with TemplateSpec.start/processCompose. */
  directRuntime?: TemplateSpec;
  /** Declared secret names mapped to replacement names in the launching workspace. */
  secretOverrides?: Record<string, string>;
  /** Unresolved file contents or raw references for this launch. */
  secretFiles?: RuntimeSecretFile[];
  secretHeaders?: SecretHeaderBinding[];
  enableOpenCode?: boolean;
  cloneRepoUrl?: string;
  volumes?: VolumeMountConfig[];
  openCodeProvider?: OpenCodeProviderConfig;
  githubToken?: string;
  sticky?: boolean;
  /** Wait until RUNNING with data-plane fields primed before returning. Defaults to true. */
  waitReady?: boolean;
  /** Overrides readiness wait. Defaults to 2 hours for direct template specs, otherwise 3 minutes. */
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
  /**
   * Wall-clock budget for the command; omitted or `0` means unbounded. Enforced
   * by the guest-agent, which caps it at its own maximum and resolves a spent
   * budget with `status: "TIMED_OUT"` rather than rejecting.
   */
  timeoutMs?: number;
  env?: Record<string, string>;
  onOutput?: (output: Output) => void;
  /** Signals the guest process and rejects the call with the signal's reason. */
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
  async?: boolean;
}

export interface UpdateSessionOptions {
  name?: string;
  tags?: string[];
  sticky?: boolean;
  // Desired lifetime when setting sticky to false. Requires an explicit sticky
  // value; sticky true discards this duration and returns a warning.
  maxDurationMs?: number;
}

export function validateUpdateMaxDurationMs(maxDurationMs: number | undefined, sticky: boolean | undefined): void {
  if (maxDurationMs !== undefined && (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0)) {
    throw new RangeError("maxDurationMs must be a positive finite number");
  }
  if (maxDurationMs !== undefined && sticky === undefined) {
    throw new TypeError("sticky must be set when maxDurationMs is provided");
  }
}

export interface UpdateSnapshotOptions {
  name?: string;
  expiresAt?: Date;
  clearExpiresAt?: boolean;
  tags?: string[];
}

export interface CreateVolumeOptions {
  workspaceId?: string;
  name: string;
  sizeBytes: number;
}

export interface UpdateVolumeOptions {
  name?: string;
  tags?: string[];
}

export interface CreateTemplateOptions {
  workspaceId?: string;
  name: string;
  /** Typed v1 recipe; cannot be combined with the legacy fields below. */
  spec?: TemplateSpec;
  baseImageId?: string;
  setupScript?: string;
  startCmd?: string;
  env?: Record<string, string>;
  tags?: string[];
  /** Template defaults. `diskSizeGb` must be 0 or 5-100; 0 leaves no disk default. */
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
  /** Template defaults. `diskSizeGb` must be 0 or 5-100; 0 leaves no disk default. */
  resources?: { cpuCores?: number; memoryMb?: number; diskSizeGb?: number };
}

export interface ListOptions {
  /** Explicit workspace scope for service-token callers. Workspace API keys infer this server-side. */
  workspaceId?: string;
  tags?: string[];
  sticky?: boolean;
  /** Include terminated sessions in results; the server omits them by default. */
  includeTerminated?: boolean;
}

export interface WorkspaceScopeOptions {
  /** Explicit workspace scope for service-token callers. Workspace API keys infer this server-side. */
  workspaceId?: string;
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

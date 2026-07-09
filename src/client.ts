import { create } from "@bufbuild/protobuf";
import { durationFromMs, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

import { createAuthInterceptor } from "./auth.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_COOKIE_NAME,
  DEFAULT_CPU_CORES,
  DEFAULT_DATA_PLANE_READY_TIMEOUT_MS,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_SESSION_CREATE_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_CREATE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ENV_API_ENDPOINT,
  ENV_API_KEY,
  ENV_API_URL,
  ENV_AUTH_TOKEN,
  ENV_GATEWAY_URL,
  pollBackoffMs,
} from "./constants.js";
import { mapError, MissingAuthTokenError, TemplateBuildFailedError, VolumeSyncPendingError } from "./errors.js";
import {
  BuildTemplateRequestSchema,
  CreateSessionRequestSchema,
  CreateSnapshotRequestSchema,
  CreateTemplateRequestSchema,
  CreateVolumeRequestSchema,
  DataPlaneRouteStatus,
  DeleteSnapshotRequestSchema,
  DeleteTemplateRequestSchema,
  DeleteVolumeRequestSchema,
  GetRegistryImageRequestSchema,
  GetSessionRequestSchema,
  GetSnapshotDownloadURLRequestSchema,
  GetSnapshotRequestSchema,
  GetTemplateBuildRequestSchema,
  GetTemplateRequestSchema,
  GetVolumeRequestSchema,
  GetWorkspaceSandboxUsageRequestSchema,
  ListDanglingSnapshotsRequestSchema,
  ListProjectSandboxesRequestSchema,
  ListProjectSnapshotsRequestSchema,
  ListProjectTemplatesRequestSchema,
  ListProjectVolumesRequestSchema,
  ListRegistryImagesRequestSchema,
  ListRegistryShareGrantsRequestSchema,
  ListSessionSnapshotsRequestSchema,
  ListSessionsRequestSchema,
  ListSnapshotsRequestSchema,
  ListTemplatesRequestSchema,
  ListVolumesRequestSchema,
  ListWorkspaceSandboxesRequestSchema,
  ListWorkspaceSnapshotsRequestSchema,
  PublishRegistryImageRequestSchema,
  ResizeVolumeRequestSchema,
  ResolveRegistryRefRequestSchema,
  RevokeRegistryShareGrantRequestSchema,
  SandboxService,
  SetRegistryImageVisibilityRequestSchema,
  ShareImageRequestSchema,
  TemplateResourcesSchema,
  UnshareRegistryImageRequestSchema,
  UpdateSessionRequestSchema,
  UpdateSnapshotRequestSchema,
  UpdateTemplateRequestSchema,
  UpdateVolumeRequestSchema,
  VolumeMountSchema,
  WhoAmIRequestSchema,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type {
  ClientOptions,
  CreateOptions,
  CreateSnapshotOptions,
  CreateTemplateOptions,
  CreateVolumeOptions,
  ListOptions,
  RegistryListOptions,
  RegistryPublishOptions,
  RegistryShareOptions,
  UpdateSessionOptions,
  UpdateSnapshotOptions,
  UpdateTemplateOptions,
  UpdateVolumeOptions,
} from "./options.js";
import { PreviewUrlClient } from "./preview-url.js";
import type {
  RegistryImage,
  RegistryImageDetail,
  RegistryListResult,
  RegistryPublishResult,
  RegistryShareGrant,
  RegistryShareResult,
  RegistryUnshareResult,
  ResolvedRegistryRef,
} from "./registry.js";
import {
  registryArtifactDetailFromProto,
  registryArtifactFromProto,
  registryArtifactSummaryFromProto,
  registryKindToProto,
  registryShareGrantFromProto,
  registrySortToProto,
  registryTagFromProto,
  registryVisibilityToProto,
  resolvedRegistryRefFromProto,
} from "./registry.js";
import { validateCreateResources, validateTemplateResources } from "./resources.js";
import { isReady, isTerminal, Session } from "./session.js";
import type { Snapshot, SnapshotDownloadURL } from "./snapshot.js";
import { snapshotFromProto, snapshotIsReady, snapshotIsTerminal } from "./snapshot.js";
import type { SSHConnection, SSHConnectOptions } from "./ssh.js";
import { connectSSH, deriveGatewayAddress } from "./ssh.js";
import type { Template, TemplateBuild } from "./template.js";
import { templateBuildFromProto, templateFromProto } from "./template.js";
import type { WorkspaceUsageLimit } from "./usage.js";
import { workspaceUsageLimitFromProto } from "./usage.js";
import type { Volume } from "./volume.js";
import { volumeFromProto, volumeIsReady, volumeIsTerminal } from "./volume.js";
import type { Identity } from "./whoami.js";

export class TenkiSandbox implements AsyncDisposable {
  private rpcClient: Client<typeof SandboxService>;
  private authToken: string;
  private gatewayAddress: string;
  private cookieName: string;
  private sshOptions?: SSHConnectOptions;
  private dataPlaneReadyTimeoutMs: number;
  readonly previewUrls: PreviewUrlClient;

  constructor(options?: ClientOptions) {
    // Auth resolution
    let authToken = options?.authToken?.trim() || env(ENV_AUTH_TOKEN) || env(ENV_API_KEY) || "";
    if (!authToken) throw new MissingAuthTokenError();
    this.authToken = authToken;

    // URL resolution
    const baseUrl = options?.baseUrl?.trim() || env(ENV_API_ENDPOINT) || env(ENV_API_URL) || DEFAULT_BASE_URL;

    // Gateway resolution
    this.gatewayAddress = options?.gatewayAddress?.trim() || env(ENV_GATEWAY_URL) || deriveGatewayAddress(baseUrl);

    this.cookieName = options?.cookieName?.trim() || DEFAULT_COOKIE_NAME;
    this.dataPlaneReadyTimeoutMs =
      options?.dataPlaneReadyTimeoutMs && options.dataPlaneReadyTimeoutMs > 0
        ? options.dataPlaneReadyTimeoutMs
        : DEFAULT_DATA_PLANE_READY_TIMEOUT_MS;
    this.sshOptions =
      options?.rootCertificates !== undefined ? { rootCertificates: options.rootCertificates } : undefined;

    const transport =
      options?.transport ??
      createGrpcTransport({
        baseUrl,
        interceptors: [createAuthInterceptor(this.authToken, this.cookieName)],
        ...(options?.rootCertificates !== undefined ? { nodeOptions: { ca: options.rootCertificates } } : {}),
      });

    this.rpcClient = createClient(SandboxService, transport);
    this.previewUrls = new PreviewUrlClient(this.rpcClient);
  }

  // -- Sessions --

  async create(options?: CreateOptions): Promise<Session> {
    const req = create(CreateSessionRequestSchema, {
      ownerType: "SERVICE",
      ownerId: "self",
      name: options?.name ?? "",
      allowInbound: options?.allowInbound ?? true,
      allowOutbound: options?.allowOutbound ?? true,
      metadata: options?.metadata ?? {},
      tags: normalizeTags(options?.tags ?? []),
      env: { ...(options?.env ?? {}) },
      sshAuthorizedKeys: options?.sshAuthorizedKeys ?? [],
      enableOpencode: options?.enableOpenCode ?? false,
      cloneRepoUrl: options?.cloneRepoUrl ?? "",
    });

    const hasSource = Boolean(options?.image?.trim() || options?.snapshotId?.trim());
    const cpuCores = options?.cpuCores ?? (hasSource ? undefined : DEFAULT_CPU_CORES);
    const memoryMb = options?.memoryMb ?? (hasSource ? undefined : DEFAULT_MEMORY_MB);
    const diskSizeGb = options?.diskSizeGb ?? (hasSource ? undefined : DEFAULT_DISK_SIZE_GB);
    validateCreateResources({ cpuCores, memoryMb, diskSizeGb });
    if (cpuCores != null) req.cpuCores = cpuCores;
    if (memoryMb != null) req.memoryMb = memoryMb;
    if (diskSizeGb != null) req.diskSizeGb = diskSizeGb;

    if (options?.maxDurationMs && options.maxDurationMs > 0) {
      req.maxDuration = durationFromMs(options.maxDurationMs);
    }
    if (options?.idleTimeoutMinutes != null) {
      req.idleTimeoutMinutes = options.idleTimeoutMinutes;
    }
    if (options?.pauseRetentionMs && options.pauseRetentionMs > 0) {
      req.pauseRetention = durationFromMs(options.pauseRetentionMs);
    }
    if (options?.sticky) {
      req.sticky = true;
    }
    const waitReady = options?.waitReady !== false;
    req.waitReady = waitReady;

    if (options?.image?.trim()) {
      req.registryRef = options.image.trim();
    } else if (options?.snapshotId?.trim()) {
      req.snapshotId = options.snapshotId.trim();
    }

    if (options?.workspaceId?.trim()) {
      req.workspaceId = options.workspaceId.trim();
    }
    if (options?.projectId?.trim()) {
      req.projectId = options.projectId.trim();
    }

    if (options?.volumes?.length) {
      req.volumes = options.volumes.map((v) =>
        create(VolumeMountSchema, {
          volumeId: v.volumeId,
          mountPath: v.mountPath,
          readonly: v.readOnly ?? false,
        }),
      );
    }

    // OpenCode provider env vars
    if (options?.openCodeProvider) {
      if (options.openCodeProvider.apiKey) req.env["OPENCODE_API_KEY"] = options.openCodeProvider.apiKey;
      if (options.openCodeProvider.baseUrl) req.env["OPENCODE_PROVIDER_BASE_URL"] = options.openCodeProvider.baseUrl;
      if (options.openCodeProvider.npm) req.env["OPENCODE_PROVIDER_NPM"] = options.openCodeProvider.npm;
    }
    if (options?.githubToken?.trim()) {
      req.env["GH_TOKEN"] = options.githubToken.trim();
      req.env["GIT_TOKEN"] = options.githubToken.trim();
    }

    try {
      const resp = await this.rpcClient.createSession(req);
      // Match the Go SDK: skip data-plane config on terminal route failure so the first op fails fast instead of retrying a dead route for the whole readiness budget.
      const dataPlane =
        resp.routeStatus === DataPlaneRouteStatus.FAILED
          ? undefined
          : { endpoint: resp.dataPlaneEndpoint, credential: resp.credential, routeStatus: resp.routeStatus };
      const session = new Session(
        this.rpcClient,
        resp.session!,
        this.authToken,
        this.gatewayAddress,
        this.cookieName,
        this.sshOptions,
        this.dataPlaneReadyTimeoutMs,
        dataPlane,
      );
      if (!waitReady) return session;
      if (isReady(session.state)) return session;
      if (isTerminal(session.state)) {
        const suffix = session.terminalError ? `: ${session.terminalError}` : "";
        throw new Error(`session entered terminal state: ${session.state}${suffix}`);
      }
      await session.waitReady(options?.waitTimeoutMs ?? DEFAULT_SESSION_CREATE_TIMEOUT_MS);
      return session;
    } catch (err) {
      throw mapError(err);
    }
  }

  async createAndWait(options?: CreateOptions & { timeoutMs?: number }): Promise<Session> {
    // Compatibility wrapper: create() already waits by default.
    const session = await this.create({
      ...options,
      waitReady: true,
      waitTimeoutMs: options?.timeoutMs ?? options?.waitTimeoutMs,
    });
    if (session.state !== "RUNNING") {
      await session.waitReady(options?.timeoutMs ?? DEFAULT_SESSION_CREATE_TIMEOUT_MS);
    }
    return session;
  }

  async get(sessionId: string): Promise<Session> {
    try {
      const resp = await this.rpcClient.getSession(create(GetSessionRequestSchema, { sessionId }));
      return new Session(
        this.rpcClient,
        resp.session!,
        this.authToken,
        this.gatewayAddress,
        this.cookieName,
        this.sshOptions,
        this.dataPlaneReadyTimeoutMs,
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  async list(options?: ListOptions): Promise<Session[]> {
    try {
      const req = create(ListSessionsRequestSchema, { pageSize: 100, tags: normalizeTags(options?.tags ?? []) });
      if (options?.sticky !== undefined) req.sticky = options.sticky;
      const resp = await this.rpcClient.listSessions(req);
      return (resp.sessions ?? []).map(
        (s) =>
          new Session(
            this.rpcClient,
            s,
            this.authToken,
            this.gatewayAddress,
            this.cookieName,
            this.sshOptions,
            this.dataPlaneReadyTimeoutMs,
          ),
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  async listWorkspaceSandboxes(workspaceId: string, options?: ListOptions): Promise<Session[]> {
    try {
      const req = create(ListWorkspaceSandboxesRequestSchema, {
        workspaceId: workspaceId.trim(),
        pageSize: 100,
        tags: normalizeTags(options?.tags ?? []),
      });
      if (options?.sticky !== undefined) req.sticky = options.sticky;
      const resp = await this.rpcClient.listWorkspaceSandboxes(req);
      return (resp.sessions ?? []).map(
        (s) =>
          new Session(
            this.rpcClient,
            s,
            this.authToken,
            this.gatewayAddress,
            this.cookieName,
            this.sshOptions,
            this.dataPlaneReadyTimeoutMs,
          ),
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Current usage vs. limits for a workspace — concurrent sessions, snapshots,
   * volumes, etc. Each entry carries `current` and an optional `max`. Look up
   * the `"active_sessions"` key to check the concurrent-session quota before
   * creating a session, so the UI can surface a "limit reached" state up front
   * instead of letting the create fail.
   */
  async getWorkspaceSandboxUsage(
    workspaceId: string,
    options?: { projectId?: string },
  ): Promise<WorkspaceUsageLimit[]> {
    try {
      const req = create(GetWorkspaceSandboxUsageRequestSchema, {
        workspaceId: workspaceId.trim(),
      });
      if (options?.projectId?.trim()) req.projectId = options.projectId.trim();
      const resp = await this.rpcClient.getWorkspaceSandboxUsage(req);
      return (resp.limits ?? []).map(workspaceUsageLimitFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listProjectSandboxes(projectId: string, options?: ListOptions): Promise<Session[]> {
    try {
      const req = create(ListProjectSandboxesRequestSchema, {
        projectId: projectId.trim(),
        pageSize: 100,
        tags: normalizeTags(options?.tags ?? []),
      });
      if (options?.sticky !== undefined) req.sticky = options.sticky;
      const resp = await this.rpcClient.listProjectSandboxes(req);
      return (resp.sessions ?? []).map(
        (s) =>
          new Session(
            this.rpcClient,
            s,
            this.authToken,
            this.gatewayAddress,
            this.cookieName,
            this.sshOptions,
            this.dataPlaneReadyTimeoutMs,
          ),
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateSession(sessionId: string, options: UpdateSessionOptions): Promise<Session> {
    const req = create(UpdateSessionRequestSchema, { sessionId: sessionId.trim() });
    if (options.name !== undefined) req.name = options.name;
    if (options.tags !== undefined) {
      const normalized = normalizeTags(options.tags);
      if (normalized.length === 0) {
        req.clearTags = true;
      } else {
        req.tags = normalized;
      }
    }
    if (options.sticky !== undefined) req.sticky = options.sticky;
    if (options.maxDurationMs && options.maxDurationMs > 0) {
      req.maxDuration = durationFromMs(options.maxDurationMs);
    }
    try {
      const resp = await this.rpcClient.updateSession(req);
      return new Session(
        this.rpcClient,
        resp.session!,
        this.authToken,
        this.gatewayAddress,
        this.cookieName,
        this.sshOptions,
        this.dataPlaneReadyTimeoutMs,
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- Snapshots --

  async createSnapshot(sessionId: string, options?: CreateSnapshotOptions): Promise<Snapshot> {
    const req = create(CreateSnapshotRequestSchema, { sessionId });
    if (options?.name?.trim()) req.name = options.name.trim();
    if (options?.expiresAt) {
      req.expiresAt = timestampFromDate(options.expiresAt);
    }
    try {
      const resp = await this.rpcClient.createSnapshot(req);
      return snapshotFromProto(resp.snapshot!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async createSnapshotAndWait(
    sessionId: string,
    options?: CreateSnapshotOptions & { timeoutMs?: number },
  ): Promise<Snapshot> {
    const snap = await this.createSnapshot(sessionId, options);
    return this.waitSnapshotReady(snap.id, options?.timeoutMs ?? DEFAULT_SNAPSHOT_CREATE_TIMEOUT_MS);
  }

  async getSnapshot(snapshotId: string): Promise<Snapshot> {
    try {
      const resp = await this.rpcClient.getSnapshot(
        create(GetSnapshotRequestSchema, { snapshotId: snapshotId.trim() }),
      );
      return snapshotFromProto(resp.snapshot!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getSnapshotDownloadURL(snapshotId: string): Promise<SnapshotDownloadURL> {
    try {
      const resp = await this.rpcClient.getSnapshotDownloadURL(
        create(GetSnapshotDownloadURLRequestSchema, {
          snapshotId: snapshotId.trim(),
        }),
      );
      return {
        url: resp.url,
        expiresAt: resp.expiresAt ? timestampDate(resp.expiresAt) : undefined,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async listSnapshots(): Promise<Snapshot[]> {
    try {
      const resp = await this.rpcClient.listSnapshots(create(ListSnapshotsRequestSchema, { pageSize: 100 }));
      return (resp.snapshots ?? []).map(snapshotFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listSessionSnapshots(sessionId: string): Promise<Snapshot[]> {
    try {
      const resp = await this.rpcClient.listSessionSnapshots(
        create(ListSessionSnapshotsRequestSchema, {
          sessionId: sessionId.trim(),
          pageSize: 100,
        }),
      );
      return (resp.snapshots ?? []).map(snapshotFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listDanglingSnapshots(): Promise<Snapshot[]> {
    try {
      const resp = await this.rpcClient.listDanglingSnapshots(
        create(ListDanglingSnapshotsRequestSchema, { pageSize: 100 }),
      );
      return (resp.snapshots ?? []).map(snapshotFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listWorkspaceSnapshots(workspaceId: string): Promise<Snapshot[]> {
    try {
      const resp = await this.rpcClient.listWorkspaceSnapshots(
        create(ListWorkspaceSnapshotsRequestSchema, {
          workspaceId: workspaceId.trim(),
          pageSize: 100,
        }),
      );
      return (resp.snapshots ?? []).map(snapshotFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listProjectSnapshots(projectId: string): Promise<Snapshot[]> {
    try {
      const resp = await this.rpcClient.listProjectSnapshots(
        create(ListProjectSnapshotsRequestSchema, {
          projectId: projectId.trim(),
          pageSize: 100,
        }),
      );
      return (resp.snapshots ?? []).map(snapshotFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<Snapshot> {
    try {
      const resp = await this.rpcClient.deleteSnapshot(create(DeleteSnapshotRequestSchema, { snapshotId }));
      return snapshotFromProto(resp.snapshot!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateSnapshot(snapshotId: string, options: UpdateSnapshotOptions): Promise<Snapshot> {
    const req = create(UpdateSnapshotRequestSchema, { snapshotId: snapshotId.trim() });
    if (options.name !== undefined) req.name = options.name;
    if (options.clearExpiresAt) req.clearExpiresAt = true;
    if (options.expiresAt) req.expiresAt = timestampFromDate(options.expiresAt);
    if (options.tags !== undefined) {
      const normalized = normalizeTags(options.tags);
      if (normalized.length === 0) {
        req.clearTags = true;
      } else {
        req.tags = normalized;
      }
    }
    try {
      const resp = await this.rpcClient.updateSnapshot(req);
      return snapshotFromProto(resp.snapshot!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async waitSnapshotReady(snapshotId: string, timeoutMs?: number, signal?: AbortSignal): Promise<Snapshot> {
    const deadline = Date.now() + (timeoutMs ?? DEFAULT_SNAPSHOT_CREATE_TIMEOUT_MS);
    let attempt = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const snap = await this.getSnapshot(snapshotId);
      if (snapshotIsReady(snap.state)) return snap;
      if (snapshotIsTerminal(snap.state)) {
        throw new Error(`snapshot entered terminal state: ${snap.state}`);
      }
      await sleep(pollBackoffMs(attempt), signal);
      attempt++;
    }
    throw new Error(`timeout waiting for snapshot ${snapshotId} to become ready`);
  }

  // -- Volumes --

  async createVolume(options: CreateVolumeOptions): Promise<Volume> {
    const req = create(CreateVolumeRequestSchema, {
      workspaceId: options.workspaceId,
      name: options.name,
      sizeBytes: BigInt(options.sizeBytes),
    });
    if (options.projectId?.trim()) req.projectId = options.projectId.trim();
    try {
      const resp = await this.rpcClient.createVolume(req);
      return volumeFromProto(resp.volume!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getVolume(volumeId: string): Promise<Volume> {
    try {
      const resp = await this.rpcClient.getVolume(create(GetVolumeRequestSchema, { volumeId }));
      return volumeFromProto(resp.volume!, resp.activeAttachments);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listVolumes(workspaceId: string): Promise<Volume[]> {
    try {
      const resp = await this.rpcClient.listVolumes(create(ListVolumesRequestSchema, { workspaceId, pageSize: 100 }));
      return (resp.volumes ?? []).map((v) => volumeFromProto(v));
    } catch (err) {
      throw mapError(err);
    }
  }

  async listProjectVolumes(projectId: string): Promise<Volume[]> {
    try {
      const resp = await this.rpcClient.listProjectVolumes(
        create(ListProjectVolumesRequestSchema, {
          projectId: projectId.trim(),
          pageSize: 100,
        }),
      );
      return (resp.volumes ?? []).map((v) => volumeFromProto(v));
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteVolume(volumeId: string, signal?: AbortSignal): Promise<void> {
    const maxElapsedMs = 60_000;
    const start = Date.now();
    let backoffMs = 1_000;

    for (;;) {
      signal?.throwIfAborted();
      try {
        await this.rpcClient.deleteVolume(create(DeleteVolumeRequestSchema, { volumeId }));
        return;
      } catch (err) {
        const mapped = mapError(err);
        if (!(mapped instanceof VolumeSyncPendingError) || Date.now() - start >= maxElapsedMs) {
          throw mapped;
        }
        await sleep(backoffMs, signal);
        if (backoffMs < 10_000) backoffMs *= 2;
      }
    }
  }

  async resizeVolume(volumeId: string, newSizeBytes: number): Promise<Volume> {
    try {
      const resp = await this.rpcClient.resizeVolume(
        create(ResizeVolumeRequestSchema, {
          volumeId,
          newSizeBytes: BigInt(newSizeBytes),
        }),
      );
      return volumeFromProto(resp.volume!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateVolume(volumeId: string, options: UpdateVolumeOptions): Promise<Volume> {
    const req = create(UpdateVolumeRequestSchema, { volumeId: volumeId.trim() });
    if (options.name !== undefined) req.name = options.name;
    if (options.tags !== undefined) {
      const normalized = normalizeTags(options.tags);
      if (normalized.length === 0) {
        req.clearTags = true;
      } else {
        req.tags = normalized;
      }
    }
    try {
      const resp = await this.rpcClient.updateVolume(req);
      return volumeFromProto(resp.volume!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async waitVolumeReady(volumeId: string, timeoutMs?: number, signal?: AbortSignal): Promise<Volume> {
    const deadline = Date.now() + (timeoutMs ?? 60_000);
    let attempt = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const vol = await this.getVolume(volumeId);
      if (volumeIsReady(vol.state)) return vol;
      if (volumeIsTerminal(vol.state)) {
        throw new Error(`volume entered terminal state: ${vol.state}`);
      }
      await sleep(pollBackoffMs(attempt), signal);
      attempt++;
    }
    throw new Error(`timeout waiting for volume ${volumeId} to become ready`);
  }

  // -- Registry --

  async listRegistryImages(options?: RegistryListOptions): Promise<RegistryListResult> {
    const req = create(ListRegistryImagesRequestSchema, {
      labels: cleanStrings(options?.labels ?? []),
    });
    if (options?.workspace?.trim()) req.workspaceSlug = options.workspace.trim();
    if (options?.nameSubstring?.trim()) req.nameSubstring = options.nameSubstring.trim();
    if (options?.kind) req.kind = registryKindToProto(options.kind);
    if (options?.sort) req.sortBy = registrySortToProto(options.sort);
    if (options?.pageSize && options.pageSize > 0) req.pageSize = options.pageSize;
    if (options?.cursor?.trim()) req.cursor = options.cursor.trim();

    try {
      const resp = await this.rpcClient.listRegistryImages(req);
      return {
        artifacts: (resp.artifacts ?? []).map(registryArtifactSummaryFromProto),
        nextCursor: resp.nextCursor,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async getRegistryImage(imageOrArtifactId: string): Promise<RegistryImageDetail> {
    const value = imageOrArtifactId.trim();
    const req = create(GetRegistryImageRequestSchema, {});
    if (looksLikeUUID(value)) {
      req.artifactId = value;
    } else {
      req.ref = value;
    }

    try {
      const resp = await this.rpcClient.getRegistryImage(req);
      return registryArtifactDetailFromProto(resp.detail);
    } catch (err) {
      throw mapError(err);
    }
  }

  async resolveRegistryRef(image: string): Promise<ResolvedRegistryRef> {
    const ref = image.trim();
    try {
      const resp = await this.rpcClient.resolveRegistryRef(create(ResolveRegistryRefRequestSchema, { ref }));
      return resolvedRegistryRefFromProto(resp.resolved);
    } catch (err) {
      throw mapError(err);
    }
  }

  async publishRegistryImage(options: RegistryPublishOptions): Promise<RegistryPublishResult> {
    const req = create(PublishRegistryImageRequestSchema, {
      labels: cleanStrings(options.labels ?? []),
    });
    if (options.artifactId?.trim()) req.artifactId = options.artifactId.trim();
    if (options.image?.trim()) req.ref = options.image.trim();
    if (options.workspaceId?.trim()) req.workspaceId = options.workspaceId.trim();
    if (options.name?.trim()) req.name = options.name.trim();
    if (options.fromTemplateId?.trim()) {
      req.kind = registryKindToProto("template");
      req.sourceTemplateId = options.fromTemplateId.trim();
    } else if (options.fromSnapshotId?.trim()) {
      req.kind = registryKindToProto("snapshot");
      req.snapshotId = options.fromSnapshotId.trim();
    }
    if (options.tag?.trim()) req.tag = options.tag.trim();
    if (options.visibility) req.visibility = registryVisibilityToProto(options.visibility);
    if (options.title?.trim()) req.title = options.title.trim();
    if (options.description?.trim()) req.description = options.description.trim();

    try {
      const resp = await this.rpcClient.publishRegistryImage(req);
      return {
        artifact: resp.artifact ? registryArtifactFromProto(resp.artifact) : undefined,
        tag: registryTagFromProto(resp.tag),
        snapshotId: resp.snapshotId,
        digestRef: resp.digestRef,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async unpublishRegistryImage(imageOrArtifactId: string): Promise<RegistryImage> {
    const value = stripRegistryTag(imageOrArtifactId.trim());
    const req = create(SetRegistryImageVisibilityRequestSchema, {
      visibility: registryVisibilityToProto("private"),
    });
    if (looksLikeUUID(value)) {
      req.artifactId = value;
    } else {
      req.ref = value;
    }

    try {
      const resp = await this.rpcClient.setRegistryImageVisibility(req);
      return registryArtifactFromProto(resp.artifact!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async shareImage(imageOrId: string, options: RegistryShareOptions): Promise<RegistryShareResult> {
    const value = imageOrId.trim();
    const req = create(ShareImageRequestSchema, {
      targetWorkspaceId: options.targetWorkspaceId?.trim() ?? "",
    });
    if (looksLikeUUID(value)) req.imageId = value;
    else req.imageRef = value;
    if (options.tag?.trim()) req.tag = options.tag.trim();
    if (options.snapshotId?.trim()) req.snapshotId = options.snapshotId.trim();
    try {
      const resp = await this.rpcClient.shareImage(req);
      return {
        image: resp.image ? registryArtifactFromProto(resp.image) : undefined,
        currentSnapshotId: resp.currentSnapshotId,
        digestRef: resp.digestRef,
        grant: registryShareGrantFromProto(resp.grant),
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async revokeRegistryShareGrant(grantId: string, reason?: string): Promise<RegistryShareGrant | undefined> {
    const req = create(RevokeRegistryShareGrantRequestSchema, { grantId: grantId.trim() });
    if (reason?.trim()) req.reason = reason.trim();
    try {
      const resp = await this.rpcClient.revokeRegistryShareGrant(req);
      return registryShareGrantFromProto(resp.grant);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listRegistryShareGrants(imageOrArtifactId: string): Promise<RegistryShareGrant[]> {
    const value = imageOrArtifactId.trim();
    const req = create(ListRegistryShareGrantsRequestSchema, {});
    if (looksLikeUUID(value)) req.artifactId = value;
    else req.ref = value;
    try {
      const resp = await this.rpcClient.listRegistryShareGrants(req);
      return (resp.grants ?? []).map((grant) => registryShareGrantFromProto(grant)!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async unshareRegistryImage(imageOrArtifactId: string, reason?: string): Promise<RegistryUnshareResult> {
    const value = imageOrArtifactId.trim();
    const req = create(UnshareRegistryImageRequestSchema, {});
    if (looksLikeUUID(value)) req.artifactId = value;
    else req.ref = value;
    if (reason?.trim()) req.reason = reason.trim();
    try {
      const resp = await this.rpcClient.unshareRegistryImage(req);
      return {
        artifact: resp.artifact ? registryArtifactFromProto(resp.artifact) : undefined,
        revokedTokenCount: resp.revokedTokenCount,
        revokedGrantCount: resp.revokedGrantCount,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- Templates --

  async createTemplate(options: CreateTemplateOptions): Promise<Template> {
    const req = create(CreateTemplateRequestSchema, {
      workspaceId: options.workspaceId,
      name: options.name,
      baseImageId: options.baseImageId ?? "",
      setupScript: options.setupScript ?? "",
      envVars: options.env ?? {},
      tags: normalizeTags(options.tags ?? []),
    });
    if (options.projectId?.trim()) req.projectId = options.projectId.trim();
    if (options.parentTemplateId?.trim()) {
      req.parentTemplateId = options.parentTemplateId.trim();
    }
    if (options.parentImage?.trim()) {
      req.parentImage = options.parentImage.trim();
    }
    if (options.startCmd != null) req.startCmd = options.startCmd;
    if (options.resources) {
      validateTemplateResources(options.resources);
      req.resources = create(TemplateResourcesSchema, {
        cpuCores: options.resources.cpuCores ?? 0,
        memoryMb: options.resources.memoryMb ?? 0,
        diskSizeGb: options.resources.diskSizeGb ?? 0,
      });
    }
    try {
      const resp = await this.rpcClient.createTemplate(req);
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getTemplate(templateId: string): Promise<Template> {
    try {
      const resp = await this.rpcClient.getTemplate(
        create(GetTemplateRequestSchema, { templateId: templateId.trim() }),
      );
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listTemplates(workspaceId: string, options?: ListOptions): Promise<Template[]> {
    try {
      const resp = await this.rpcClient.listTemplates(
        create(ListTemplatesRequestSchema, {
          workspaceId: workspaceId.trim(),
          pageSize: 100,
          tags: normalizeTags(options?.tags ?? []),
        }),
      );
      return (resp.templates ?? []).map(templateFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listProjectTemplates(projectId: string, options?: ListOptions): Promise<Template[]> {
    try {
      const resp = await this.rpcClient.listProjectTemplates(
        create(ListProjectTemplatesRequestSchema, {
          projectId: projectId.trim(),
          pageSize: 100,
          tags: normalizeTags(options?.tags ?? []),
        }),
      );
      return (resp.templates ?? []).map(templateFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateTemplate(templateId: string, options: UpdateTemplateOptions): Promise<Template> {
    const req = create(UpdateTemplateRequestSchema, {
      templateId: templateId.trim(),
    });
    if (options.name != null) req.name = options.name;
    if (options.baseImageId != null) req.baseImageId = options.baseImageId;
    if (options.setupScript != null) req.setupScript = options.setupScript;
    if (options.startCmd != null) req.startCmd = options.startCmd;
    if (options.env != null) req.envVars = { ...options.env };
    if (options.tags != null) {
      const normalized = normalizeTags(options.tags);
      if (normalized.length === 0) {
        req.clearTags = true;
      } else {
        req.tags = normalized;
      }
    }
    if (options.resources) {
      validateTemplateResources(options.resources);
      req.resources = create(TemplateResourcesSchema, {
        cpuCores: options.resources.cpuCores ?? 0,
        memoryMb: options.resources.memoryMb ?? 0,
        diskSizeGb: options.resources.diskSizeGb ?? 0,
      });
    }
    try {
      const resp = await this.rpcClient.updateTemplate(req);
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteTemplate(templateId: string): Promise<Template> {
    try {
      const resp = await this.rpcClient.deleteTemplate(
        create(DeleteTemplateRequestSchema, { templateId: templateId.trim() }),
      );
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async buildTemplate(templateId: string, options?: { publishRawImage?: boolean }): Promise<TemplateBuild> {
    try {
      const resp = await this.rpcClient.buildTemplate(
        create(BuildTemplateRequestSchema, {
          templateId: templateId.trim(),
          ...(options?.publishRawImage !== undefined ? { publishRawImage: options.publishRawImage } : {}),
        }),
      );
      return templateBuildFromProto(resp.build)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async getTemplateBuild(buildId: string): Promise<TemplateBuild> {
    try {
      const resp = await this.rpcClient.getTemplateBuild(
        create(GetTemplateBuildRequestSchema, { buildId: buildId.trim() }),
      );
      return templateBuildFromProto(resp.build)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async waitForTemplateBuild(buildId: string, signal?: AbortSignal): Promise<TemplateBuild> {
    let attempt = 0;
    while (true) {
      signal?.throwIfAborted();
      const build = await this.getTemplateBuild(buildId);
      if (build.state === "READY") return build;
      if (build.state === "FAILED") {
        throw new TemplateBuildFailedError(build.error || "template build failed");
      }
      await sleep(pollBackoffMs(attempt), signal);
      attempt++;
    }
  }

  // -- Identity --

  async whoAmI(): Promise<Identity> {
    try {
      const resp = await this.rpcClient.whoAmI(create(WhoAmIRequestSchema, {}));
      return {
        ownerType: resp.ownerType,
        ownerId: resp.ownerId,
        workspaces: (resp.workspaces ?? []).map((ws) => ({
          id: ws.workspaceId,
          name: ws.name,
          projects: (ws.projects ?? []).map((p) => ({
            id: p.projectId,
            name: p.name,
          })),
        })),
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- SSH --

  async ssh(sessionId: string): Promise<SSHConnection> {
    return connectSSH(this.gatewayAddress, sessionId, this.authToken, this.cookieName, this.sshOptions);
  }

  // -- Cleanup --

  close(): void {
    // No persistent connections to close with connect-node transport
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

function normalizeTags(tags: string[]): string[] {
  return tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
}

function cleanStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function looksLikeUUID(value: string): boolean {
  return value.length === 36 && (value.match(/-/g)?.length ?? 0) === 4;
}

function stripRegistryTag(value: string): string {
  const slash = value.lastIndexOf("/");
  const colon = value.lastIndexOf(":");
  if (slash >= 0 && colon > slash) return value.slice(0, colon);
  return value;
}

function env(key: string): string {
  return (typeof process !== "undefined" && process.env?.[key]) || "";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

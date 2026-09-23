import { create } from "@bufbuild/protobuf";
import { durationFromMs, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport, type Http2SessionManager } from "@connectrpc/connect-node";

import { createAuthInterceptor, resolveAuthToken } from "./auth.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CPU_CORES,
  DEFAULT_DATA_PLANE_READY_TIMEOUT_MS,
  DEFAULT_DISK_SIZE_GB,
  DEFAULT_MEMORY_MB,
  DEFAULT_SESSION_CREATE_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_CREATE_TIMEOUT_MS,
  DEFAULT_TEMPLATE_SPEC_CREATE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ENV_API_ENDPOINT,
  ENV_API_URL,
  ENV_GATEWAY_URL,
  pollBackoffMs,
} from "./constants.js";
import {
  InvalidTemplateSpecError,
  mapError,
  TemplateBuildFailedError,
  TemplateRuntimeFailedError,
  VolumeSyncPendingError,
  WaitReadyFailedError,
} from "./errors.js";
import { DrainingHttp2SessionManager } from "./http2-drain.js";
import {
  DeleteRegistryImageRequestSchema,
  DeleteRegistryImageVersionRequestSchema,
  GetRegistryImageRequestSchema,
  ListRegistryImagesRequestSchema,
  ListRegistryShareGrantsRequestSchema,
  PublishRegistryImageRequestSchema,
  ResolveRegistryRefRequestSchema,
  RevokeRegistryShareGrantRequestSchema,
  SetRegistryImageVisibilityRequestSchema,
  ShareImageRequestSchema,
  UnshareRegistryImageRequestSchema,
} from "./internal/proto/tenki/sandbox/v1/registry_pb.js";
import {
  CreateSessionRequestSchema,
  CreateSnapshotRequestSchema,
  CreateVolumeRequestSchema,
  DataPlaneRouteStatus,
  DeleteSnapshotRequestSchema,
  DeleteVolumeRequestSchema,
  GetSessionMetricsRequestSchema,
  GetSessionRequestSchema,
  GetSnapshotDownloadURLRequestSchema,
  GetSnapshotRequestSchema,
  GetVolumeRequestSchema,
  GetWorkspaceSandboxUsageRequestSchema,
  ListDanglingSnapshotsRequestSchema,
  ListSessionSnapshotsRequestSchema,
  ListVolumesRequestSchema,
  ListWorkspaceSandboxesRequestSchema,
  ListWorkspaceSnapshotsRequestSchema,
  ResizeVolumeRequestSchema,
  SandboxService,
  SessionEgressPolicySchema,
  TemplateRuntimeFailureSchema,
  UpdateSessionRequestSchema,
  UpdateSnapshotRequestSchema,
  UpdateVolumeRequestSchema,
  VolumeMountSchema,
  WhoAmIRequestSchema,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { SSHGatewayClientService } from "./internal/proto/tenki/sandbox/v1/ssh_gateway_client_pb.js";
import {
  BuildTemplateRequestSchema,
  CancelTemplateBuildRequestSchema,
  CreateTemplateRequestSchema,
  DeleteTemplateRequestSchema,
  GetTemplateBuildRequestSchema,
  GetTemplateRequestSchema,
  ListActiveTemplateBuildsRequestSchema,
  ListTemplatesRequestSchema,
  TemplateResourcesSchema,
  UpdateTemplateRequestSchema,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import type { SessionMetrics } from "./metrics.js";
import { sessionMetricsFromProto } from "./metrics.js";
import type {
  ClientOptions,
  CreateOptions,
  CreateSnapshotOptions,
  CreateTemplateOptions,
  CreateVolumeOptions,
  ListOptions,
  RegistryListOptions,
  RegistryLookupOptions,
  RegistryPublishOptions,
  RegistryShareOptions,
  UpdateSessionOptions,
  UpdateSnapshotOptions,
  UpdateTemplateOptions,
  UpdateVolumeOptions,
  WorkspaceScopeOptions,
} from "./options.js";
import { validateUpdateMaxDurationMs } from "./options.js";
import { advancePageToken, automaticPageSize } from "./pagination.js";
import { PreviewUrlClient } from "./preview-url.js";
import type {
  RegistryDeleteResult,
  RegistryImage,
  RegistryImageDetail,
  RegistryListResult,
  RegistryPublishResult,
  RegistryShareGrant,
  RegistryShareResult,
  RegistryUnshareResult,
  RegistryVersionDeleteResult,
  ResolvedRegistryRef,
} from "./registry.js";
import {
  registryImageDetailFromProto,
  registryImageFromProto,
  registryImageSummaryFromProto,
  registryKindToProto,
  registryShareGrantFromProto,
  registrySortToProto,
  registryTagFromProto,
  registryVisibilityToProto,
  resolvedRegistryRefFromProto,
} from "./registry.js";
import { validateCreateResources, validateTemplateResources } from "./resources.js";
import { secretFileToProto, validSecretFiles } from "./secret-files.js";
import { isReady, isTerminal, Session } from "./session.js";
import type { Snapshot, SnapshotDownloadURL } from "./snapshot.js";
import { snapshotFromProto, snapshotIsReady, snapshotIsTerminal } from "./snapshot.js";
import type { SSHCert } from "./ssh-cert.js";
import { issueSandboxSSHCert } from "./ssh-cert.js";
import type { SSHConnection, SSHConnectOptions } from "./ssh.js";
import { connectSSH, deriveGatewayAddress, discoverSSHGatewayUrl } from "./ssh.js";
import type { TemplateSpec, TemplateSpecViolation } from "./template-spec.js";
import type {
  Template,
  TemplateBuild,
  TemplateBuildOptions,
  TemplateBuildWaitOptions,
  TemplateImageRef,
} from "./template.js";
import { templateBuildFromProto, templateFromProto } from "./template.js";
import type { WorkspaceUsageLimit } from "./usage.js";
import { workspaceUsageLimitFromProto } from "./usage.js";
import type { Volume } from "./volume.js";
import { volumeFromProto, volumeIsReady, volumeIsTerminal } from "./volume.js";
import { defaultWarningHandler, emitWarnings, sandboxWarningsFromProto, type WarningHandler } from "./warning.js";
import type { Identity } from "./whoami.js";

export class TenkiSandbox implements AsyncDisposable {
  private rpcClient: Client<typeof SandboxService>;
  private sshGatewayClient: Client<typeof SSHGatewayClientService>;
  private authToken: string;
  private gatewayAddress: string;
  private sshOptions?: SSHConnectOptions;
  private dataPlaneReadyTimeoutMs: number;
  private readonly warningHandler?: WarningHandler;
  private sessionManager?: Http2SessionManager;
  readonly previewUrls: PreviewUrlClient;

  constructor(options?: ClientOptions) {
    this.warningHandler =
      options?.warningHandler === undefined ? defaultWarningHandler : (options.warningHandler ?? undefined);
    this.authToken = resolveAuthToken(options?.authToken, options?.apiKey);

    // URL resolution
    const baseUrl = options?.baseUrl?.trim() || env(ENV_API_ENDPOINT) || env(ENV_API_URL) || DEFAULT_BASE_URL;

    // Explicit SSH gateway overrides disable automatic gateway discovery.
    const pinnedGateway = options?.gatewayAddress?.trim() || env(ENV_GATEWAY_URL) || "";
    this.gatewayAddress = pinnedGateway || deriveGatewayAddress(baseUrl);

    this.dataPlaneReadyTimeoutMs =
      options?.dataPlaneReadyTimeoutMs && options.dataPlaneReadyTimeoutMs > 0
        ? options.dataPlaneReadyTimeoutMs
        : DEFAULT_DATA_PLANE_READY_TIMEOUT_MS;

    const sessionManager = options?.transport
      ? undefined
      : new DrainingHttp2SessionManager(
          baseUrl,
          undefined,
          options?.rootCertificates !== undefined ? { ca: options.rootCertificates } : undefined,
        );
    this.sessionManager = sessionManager;
    void sessionManager?.connect().catch(() => {});
    const transport =
      options?.transport ??
      createGrpcTransport({
        baseUrl,
        interceptors: [createAuthInterceptor(this.authToken)],
        sessionManager,
      });

    this.rpcClient = createClient(SandboxService, transport);
    this.sshGatewayClient = createClient(SSHGatewayClientService, transport);
    this.previewUrls = new PreviewUrlClient(this.rpcClient);

    const sshOptions: SSHConnectOptions = {
      ...(options?.rootCertificates !== undefined ? { rootCertificates: options.rootCertificates } : {}),
      ...(pinnedGateway ? {} : { discoverGateway: (sid: string) => discoverSSHGatewayUrl(this.sshGatewayClient, sid) }),
    };
    this.sshOptions = Object.keys(sshOptions).length > 0 ? sshOptions : undefined;
  }

  // -- Sessions --

  /** cpuCores is 1-128 and memoryMb 128-524288 (even); the workspace's size limit may be lower. */
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
      setupEnv: { ...(options?.setupEnv ?? {}) },
      setupSecrets: { ...(options?.setupSecrets ?? {}) },
      runtime: options?.directRuntime?.toDirectRuntimeProto(),
      secretOverrides: { ...(options?.secretOverrides ?? {}) },
      secretFiles: (options?.secretFiles ?? []).map(secretFileToProto),
    });

    if (!validSecretFiles(req.secretFiles, 0) || req.secretFiles.some((file) => file.format.case === "source")) {
      throw new Error("Invalid direct secret files; image source paths require a template build");
    }
    if (options?.allowDomains?.length || options?.allowCidrs?.length) {
      req.egress = create(SessionEgressPolicySchema, {
        allowDomains: options?.allowDomains ?? [],
        allowCidrs: options?.allowCidrs ?? [],
      });
    }

    const image = registryRefOf(options?.image);
    const templateSpecId = options?.fromTemplateSpec ? resourceIdOf(options.fromTemplateSpec) : "";
    const snapshotId = options?.snapshotId?.trim() ?? "";
    if ([image, snapshotId, templateSpecId].filter(Boolean).length > 1) {
      throw new Error("Only one of image, snapshotId, or fromTemplateSpec may be set");
    }
    const hasSource = Boolean(image || snapshotId || templateSpecId);
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
      warnIdleTimeoutDeprecated();
    }
    if (options?.pauseRetentionMs && options.pauseRetentionMs > 0) {
      req.pauseRetention = durationFromMs(options.pauseRetentionMs);
    }
    if (options?.sticky) {
      req.sticky = true;
    }
    const waitReady = options?.waitReady !== false;
    if (req.runtime && options?.fromTemplateSpec)
      throw new InvalidTemplateSpecError("directRuntime conflicts with fromTemplateSpec");
    const waitForRuntime = options?.waitForRuntime ?? false;
    // Wait client-side so WaitSession can expose the endpoint and prewarm the data plane during provision.
    req.waitReady = waitReady && waitForRuntime;
    req.waitForRuntime = waitForRuntime;

    if (image) {
      req.registryRef = image;
    } else if (snapshotId) {
      req.snapshotId = snapshotId;
    } else if (templateSpecId) {
      req.templateSpecId = templateSpecId;
    }

    const workspaceId = options?.workspaceId?.trim();
    if (workspaceId) req.workspaceId = workspaceId;

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

    for (const target of Object.keys(req.runtime?.secretEnv ?? {})) {
      if (Object.hasOwn(req.env, target))
        throw new InvalidTemplateSpecError("secret target conflicts with session environment");
    }

    let resp;
    try {
      resp = await this.rpcClient.createSession(req);
    } catch (err) {
      const runtimeFailure = ConnectError.from(err).findDetails(TemplateRuntimeFailureSchema)[0];
      if (runtimeFailure?.session) {
        const session = new Session(
          this.rpcClient,
          runtimeFailure.session,
          this.authToken,
          this.gatewayAddress,
          this.sshOptions,
          this.dataPlaneReadyTimeoutMs,
          undefined,
          [],
          this.warningHandler,
        );
        throw new TemplateRuntimeFailedError(runtimeFailure.reason || "template runtime failed", session, {
          cause: err instanceof Error ? err : undefined,
        });
      }
      throw mapError(err);
    }

    const warnings = sandboxWarningsFromProto(resp.warnings);
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
      this.sshOptions,
      this.dataPlaneReadyTimeoutMs,
      dataPlane,
      warnings,
      this.warningHandler,
    );
    emitWarnings(this.warningHandler, warnings);
    if (!waitReady) return session;
    if (isReady(session.state)) return session;
    if (isTerminal(session.state)) {
      const suffix = session.terminalError ? `: ${session.terminalError}` : "";
      throw mapError(new Error(`session entered terminal state: ${session.state}${suffix}`));
    }
    try {
      await session.waitReady(
        options?.waitTimeoutMs ??
          (templateSpecId ? DEFAULT_TEMPLATE_SPEC_CREATE_TIMEOUT_MS : DEFAULT_SESSION_CREATE_TIMEOUT_MS),
      );
    } catch (waitErr) {
      if (isTerminal(session.state)) throw mapError(waitErr);
      throw new WaitReadyFailedError(`session ${session.id} created but not ready within wait budget`, session, {
        cause: waitErr instanceof Error ? waitErr : undefined,
      });
    }
    return session;
  }

  async createAndWait(options?: CreateOptions & { timeoutMs?: number }): Promise<Session> {
    // Compatibility wrapper: create() already waits by default.
    const waitTimeoutMs =
      options?.timeoutMs ??
      options?.waitTimeoutMs ??
      (options?.fromTemplateSpec ? DEFAULT_TEMPLATE_SPEC_CREATE_TIMEOUT_MS : DEFAULT_SESSION_CREATE_TIMEOUT_MS);
    const session = await this.create({
      ...options,
      waitReady: true,
      waitTimeoutMs,
    });
    if (session.state !== "RUNNING") {
      try {
        await session.waitReady(waitTimeoutMs);
      } catch (waitErr) {
        if (isTerminal(session.state)) throw waitErr;
        throw new WaitReadyFailedError(`session ${session.id} created but not ready within wait budget`, session, {
          cause: waitErr instanceof Error ? waitErr : undefined,
        });
      }
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
        this.sshOptions,
        this.dataPlaneReadyTimeoutMs,
        undefined,
        [],
        this.warningHandler,
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  async getSessionMetrics(sessionId: string, windowMs?: number): Promise<SessionMetrics> {
    const req = create(GetSessionMetricsRequestSchema, { sessionId: sessionId.trim() });
    if (windowMs !== undefined && windowMs !== 0) req.window = durationFromMs(windowMs);
    try {
      return sessionMetricsFromProto(await this.rpcClient.getSessionMetrics(req));
    } catch (err) {
      throw mapError(err);
    }
  }

  async list(options?: ListOptions): Promise<Session[]> {
    try {
      const sessions: Session[] = [];
      let pageToken = "";
      do {
        const req = create(ListWorkspaceSandboxesRequestSchema, {
          workspaceId: options?.workspaceId,
          pageSize: automaticPageSize(),
          pageToken,
          tags: normalizeTags(options?.tags ?? []),
          includeTerminated: options?.includeTerminated ?? false,
        });
        if (options?.sticky !== undefined) req.sticky = options.sticky;
        const resp = await this.rpcClient.listWorkspaceSandboxes(req);
        sessions.push(
          ...(resp.sessions ?? []).map(
            (s) =>
              new Session(
                this.rpcClient,
                s,
                this.authToken,
                this.gatewayAddress,
                this.sshOptions,
                this.dataPlaneReadyTimeoutMs,
                undefined,
                [],
                this.warningHandler,
              ),
          ),
        );
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return sessions;
    } catch (err) {
      throw mapError(err);
    }
  }

  /**
   * Current usage vs. limits for a workspace — concurrent sessions, snapshots,
   * volumes, etc. Each entry carries `current` and an optional `max`. Look up
   * the `"max_concurrent_jobs"` key to check the shared concurrency quota before
   * creating a session, so the UI can surface a "limit reached" state up front
   * instead of letting the create fail.
   */
  async getUsage(): Promise<WorkspaceUsageLimit[]> {
    try {
      const req = create(GetWorkspaceSandboxUsageRequestSchema, {});
      const resp = await this.rpcClient.getWorkspaceSandboxUsage(req);
      return (resp.limits ?? []).map(workspaceUsageLimitFromProto);
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateSession(sessionId: string, options: UpdateSessionOptions): Promise<Session> {
    validateUpdateMaxDurationMs(options.maxDurationMs, options.sticky);
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
    if (options.maxDurationMs !== undefined) {
      req.maxDuration = durationFromMs(options.maxDurationMs);
    }
    let resp;
    try {
      resp = await this.rpcClient.updateSession(req);
    } catch (err) {
      throw mapError(err);
    }
    const warnings = sandboxWarningsFromProto(resp.warnings);
    const session = new Session(
      this.rpcClient,
      resp.session!,
      this.authToken,
      this.gatewayAddress,
      this.sshOptions,
      this.dataPlaneReadyTimeoutMs,
      undefined,
      warnings,
      this.warningHandler,
    );
    emitWarnings(this.warningHandler, warnings);
    return session;
  }

  // -- Snapshots --

  async createSnapshot(sessionId: string, options?: CreateSnapshotOptions): Promise<Snapshot> {
    const req = create(CreateSnapshotRequestSchema, { sessionId });
    if (options?.name?.trim()) req.name = options.name.trim();
    if (options?.expiresAt) {
      req.expiresAt = timestampFromDate(options.expiresAt);
    }
    req.async = options?.async ?? false;
    try {
      const resp = await this.rpcClient.createSnapshot(req);
      return snapshotFromProto(resp.snapshot!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async createSnapshotAsync(sessionId: string, options?: CreateSnapshotOptions): Promise<Snapshot> {
    return this.createSnapshot(sessionId, { ...options, async: true });
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

  async listSnapshots(options?: WorkspaceScopeOptions): Promise<Snapshot[]> {
    try {
      const snapshots: Snapshot[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listWorkspaceSnapshots(
          create(ListWorkspaceSnapshotsRequestSchema, {
            workspaceId: options?.workspaceId,
            pageSize: automaticPageSize(),
            pageToken,
          }),
        );
        snapshots.push(...(resp.snapshots ?? []).map(snapshotFromProto));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return snapshots;
    } catch (err) {
      throw mapError(err);
    }
  }

  async listSessionSnapshots(sessionId: string): Promise<Snapshot[]> {
    try {
      const snapshots: Snapshot[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listSessionSnapshots(
          create(ListSessionSnapshotsRequestSchema, {
            sessionId: sessionId.trim(),
            pageSize: automaticPageSize(),
            pageToken,
          }),
        );
        snapshots.push(...(resp.snapshots ?? []).map(snapshotFromProto));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return snapshots;
    } catch (err) {
      throw mapError(err);
    }
  }

  async listDanglingSnapshots(): Promise<Snapshot[]> {
    try {
      const snapshots: Snapshot[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listDanglingSnapshots(
          create(ListDanglingSnapshotsRequestSchema, { pageSize: automaticPageSize(), pageToken }),
        );
        snapshots.push(...(resp.snapshots ?? []).map(snapshotFromProto));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return snapshots;
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
      name: options.name,
      sizeBytes: BigInt(options.sizeBytes),
    });
    if (options.workspaceId?.trim()) req.workspaceId = options.workspaceId.trim();
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

  async listVolumes(options?: WorkspaceScopeOptions): Promise<Volume[]> {
    try {
      const volumes: Volume[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listVolumes(
          create(ListVolumesRequestSchema, {
            workspaceId: options?.workspaceId,
            pageSize: automaticPageSize(),
            pageToken,
          }),
        );
        volumes.push(...(resp.volumes ?? []).map((v) => volumeFromProto(v)));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return volumes;
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
        images: (resp.images ?? []).map(registryImageSummaryFromProto),
        nextCursor: resp.nextCursor,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async getRegistryImage(imageOrId: string, options?: RegistryLookupOptions): Promise<RegistryImageDetail> {
    const value = imageOrId.trim();
    const req = create(GetRegistryImageRequestSchema, {});
    if (options?.workspaceId?.trim()) req.workspaceId = options.workspaceId.trim();
    if (looksLikeUUID(value)) {
      req.imageId = value;
    } else {
      req.ref = value;
    }

    try {
      const resp = await this.rpcClient.getRegistryImage(req);
      return registryImageDetailFromProto(resp.detail);
    } catch (err) {
      throw mapError(err);
    }
  }

  async resolveRegistryRef(image: string, options?: RegistryLookupOptions): Promise<ResolvedRegistryRef> {
    const ref = image.trim();
    try {
      const resp = await this.rpcClient.resolveRegistryRef(
        create(ResolveRegistryRefRequestSchema, { ref, workspaceId: options?.workspaceId?.trim() }),
      );
      return resolvedRegistryRefFromProto(resp.resolved);
    } catch (err) {
      throw mapError(err);
    }
  }

  async publishRegistryImage(options: RegistryPublishOptions): Promise<RegistryPublishResult> {
    const req = create(PublishRegistryImageRequestSchema, {
      labels: cleanStrings(options.labels ?? []),
    });
    if (options.imageId?.trim()) req.imageId = options.imageId.trim();
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
        image: resp.image ? registryImageFromProto(resp.image) : undefined,
        tag: registryTagFromProto(resp.tag),
        snapshotId: resp.snapshotId,
        digestRef: resp.digestRef,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async unpublishRegistryImage(imageOrId: string): Promise<RegistryImage> {
    const value = stripRegistryTag(imageOrId.trim());
    const req = create(SetRegistryImageVisibilityRequestSchema, {
      visibility: registryVisibilityToProto("private"),
    });
    if (looksLikeUUID(value)) {
      req.imageId = value;
    } else {
      req.ref = value;
    }

    try {
      const resp = await this.rpcClient.setRegistryImageVisibility(req);
      return registryImageFromProto(resp.image!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteRegistryImage(imageOrId: string, reason?: string): Promise<RegistryDeleteResult> {
    const value = imageOrId.trim();
    const req = create(DeleteRegistryImageRequestSchema, {});
    if (looksLikeUUID(value)) req.imageId = value;
    else req.ref = value;
    if (reason?.trim()) req.reason = reason.trim();

    try {
      const resp = await this.rpcClient.deleteRegistryImage(req);
      return {
        image: resp.image ? registryImageFromProto(resp.image) : undefined,
        revokedTokenCount: resp.revokedTokenCount,
        revokedGrantCount: resp.revokedGrantCount,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteRegistryImageVersion(imageId: string, snapshotId: string): Promise<RegistryVersionDeleteResult> {
    const req = create(DeleteRegistryImageVersionRequestSchema, {
      imageId: imageId.trim(),
      snapshotId: snapshotId.trim(),
    });

    try {
      const resp = await this.rpcClient.deleteRegistryImageVersion(req);
      return {
        imageId: resp.imageId,
        snapshotId: resp.snapshotId,
      };
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
        image: resp.image ? registryImageFromProto(resp.image) : undefined,
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

  async listRegistryShareGrants(imageOrId: string): Promise<RegistryShareGrant[]> {
    const value = imageOrId.trim();
    const req = create(ListRegistryShareGrantsRequestSchema, {});
    if (looksLikeUUID(value)) req.imageId = value;
    else req.ref = value;
    try {
      const resp = await this.rpcClient.listRegistryShareGrants(req);
      return (resp.grants ?? []).map((grant) => registryShareGrantFromProto(grant)!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async unshareRegistryImage(imageOrId: string, reason?: string): Promise<RegistryUnshareResult> {
    const value = imageOrId.trim();
    const req = create(UnshareRegistryImageRequestSchema, {});
    if (looksLikeUUID(value)) req.imageId = value;
    else req.ref = value;
    if (reason?.trim()) req.reason = reason.trim();
    try {
      const resp = await this.rpcClient.unshareRegistryImage(req);
      return {
        image: resp.image ? registryImageFromProto(resp.image) : undefined,
        revokedTokenCount: resp.revokedTokenCount,
        revokedGrantCount: resp.revokedGrantCount,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- Templates --

  async createTemplate(options: CreateTemplateOptions): Promise<Template> {
    if (options.spec) {
      assertNoLegacyTemplateFields(options, [
        "baseImageId",
        "setupScript",
        "startCmd",
        "env",
        "resources",
        "parentTemplateId",
        "parentImage",
      ]);
      assertValidTemplateSpec(options.spec);
    }
    const req = create(CreateTemplateRequestSchema, {
      name: options.name,
      baseImageId: options.baseImageId ?? "",
      setupScript: options.setupScript ?? "",
      envVars: options.env ?? {},
      tags: normalizeTags(options.tags ?? []),
    });
    if (options.workspaceId?.trim()) req.workspaceId = options.workspaceId.trim();
    if (options.spec) req.builderSpec = options.spec.toProto();
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

  async getTemplate(template: Template | string): Promise<Template> {
    try {
      const resp = await this.rpcClient.getTemplate(
        create(GetTemplateRequestSchema, { templateId: resourceIdOf(template) }),
      );
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async listTemplates(options?: ListOptions): Promise<Template[]> {
    try {
      const templates: Template[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listTemplates(
          create(ListTemplatesRequestSchema, {
            workspaceId: options?.workspaceId,
            pageSize: automaticPageSize(),
            pageToken,
            tags: normalizeTags(options?.tags ?? []),
          }),
        );
        templates.push(...(resp.templates ?? []).map(templateFromProto));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return templates;
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateTemplate(template: Template | string, options: UpdateTemplateOptions): Promise<Template> {
    if (options.spec) {
      assertNoLegacyTemplateFields(options, ["baseImageId", "setupScript", "startCmd", "env", "resources"]);
      assertValidTemplateSpec(options.spec);
    }
    const req = create(UpdateTemplateRequestSchema, {
      templateId: resourceIdOf(template),
    });
    if (options.spec) req.builderSpec = options.spec.toProto();
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

  async deleteTemplate(template: Template | string): Promise<Template> {
    try {
      const resp = await this.rpcClient.deleteTemplate(
        create(DeleteTemplateRequestSchema, { templateId: resourceIdOf(template) }),
      );
      return templateFromProto(resp.template!);
    } catch (err) {
      throw mapError(err);
    }
  }

  async buildTemplate(template: Template | string, options?: TemplateBuildOptions): Promise<TemplateBuild> {
    let build: TemplateBuild;
    try {
      const resp = await this.rpcClient.buildTemplate(
        create(BuildTemplateRequestSchema, {
          templateId: resourceIdOf(template),
          ...(options?.buildEnv !== undefined ? { buildEnv: { ...options.buildEnv } } : {}),
          ...(options?.buildSecrets !== undefined ? { buildSecrets: { ...options.buildSecrets } } : {}),
          ...(options?.publishRawImage !== undefined ? { publishRawImage: options.publishRawImage } : {}),
        }),
      );
      build = templateBuildFromProto(resp.build)!;
    } catch (err) {
      throw mapError(err);
    }
    if (options?.waitForCompletion) {
      // Outside the RPC error mapping: handler or abort failures must surface as-is.
      return this.waitForTemplateBuild(build, { signal: options.signal, onEvent: options.onEvent });
    }
    return build;
  }

  async getTemplateBuild(build: TemplateBuild | string): Promise<TemplateBuild> {
    try {
      const resp = await this.rpcClient.getTemplateBuild(
        create(GetTemplateBuildRequestSchema, { buildId: resourceIdOf(build) }),
      );
      return templateBuildFromProto(resp.build)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async listActiveTemplateBuilds(template: Template | string): Promise<TemplateBuild[]> {
    try {
      const resp = await this.rpcClient.listActiveTemplateBuilds(
        create(ListActiveTemplateBuildsRequestSchema, { templateId: resourceIdOf(template) }),
      );
      return resp.builds.map((build) => templateBuildFromProto(build)!);
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Waits for or reconnects to a build; handler/signal failure stops local observation only. */
  async waitForTemplateBuild(
    build: TemplateBuild | string,
    signalOrOptions?: AbortSignal | TemplateBuildWaitOptions,
  ): Promise<TemplateBuild> {
    const options: TemplateBuildWaitOptions =
      signalOrOptions && "throwIfAborted" in signalOrOptions ? { signal: signalOrOptions } : (signalOrOptions ?? {});
    const buildId = resourceIdOf(build);
    const seenEvents = { count: 0 };
    let attempt = 0;
    while (true) {
      options.signal?.throwIfAborted();
      const current = await this.getTemplateBuild(buildId);
      if (options.onEvent) {
        for (; seenEvents.count < current.events.length; seenEvents.count++) {
          await options.onEvent(current.events[seenEvents.count]!);
        }
      }
      if (current.state === "READY") return current;
      if (current.state === "FAILED") {
        throw new TemplateBuildFailedError(
          current.failure?.message || current.error || "template build failed",
          current,
        );
      }
      await sleep(pollBackoffMs(attempt), options.signal);
      attempt++;
    }
  }

  /** Explicitly cancels the remote build; disconnecting an observer never does. */
  async cancelTemplateBuild(build: TemplateBuild | string): Promise<TemplateBuild> {
    try {
      const resp = await this.rpcClient.cancelTemplateBuild(
        create(CancelTemplateBuildRequestSchema, { buildId: resourceIdOf(build) }),
      );
      return templateBuildFromProto(resp.build)!;
    } catch (err) {
      throw mapError(err);
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
        })),
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- SSH --

  async ssh(sessionId: string): Promise<SSHConnection> {
    return connectSSH(this.gatewayAddress, sessionId, this.authToken, this.sshOptions);
  }

  /**
   * Mint a short-lived OpenSSH user certificate for the session. Authenticate
   * an SSH implementation over the raw `ssh()` transport with the matching
   * private key and returned certificate. OpenSSH auto-loads `sshCert` when it
   * is saved beside the private key as `<key>-cert.pub`.
   */
  async issueSandboxSSHCert(sessionId: string, publicKey: string, options?: { ttlMs?: number }): Promise<SSHCert> {
    try {
      return await issueSandboxSSHCert(this.sshGatewayClient, sessionId, publicKey, options?.ttlMs);
    } catch (err) {
      throw mapError(err);
    }
  }

  // -- Cleanup --

  close(): void {
    this.sessionManager?.abort();
    this.sessionManager = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

let idleTimeoutDeprecationWarned = false;

function warnIdleTimeoutDeprecated(): void {
  if (idleTimeoutDeprecationWarned) return;
  idleTimeoutDeprecationWarned = true;
  console.warn(
    "tenki sandbox: idleTimeoutMinutes is deprecated and ignored; sandboxes do not auto-pause on idle. Use maxDurationMs to bound a session's lifetime.",
  );
}

function normalizeTags(tags: string[]): string[] {
  return tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
}

function cleanStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function resourceIdOf(value: string | { id: string }): string {
  return (typeof value === "string" ? value : value.id).trim();
}

function registryRefOf(image: string | TemplateImageRef | undefined): string {
  if (!image) return "";
  if (typeof image === "string") return image.trim();
  return image.digestRef?.trim() || image.ref?.trim() || "";
}

function assertNoLegacyTemplateFields<T extends object>(options: T, legacyFields: (keyof T & string)[]): void {
  const set = legacyFields.filter((field) => options[field] !== undefined);
  if (set.length > 0) {
    throw new InvalidTemplateSpecError(`spec cannot be combined with legacy template fields: ${set.join(", ")}`);
  }
}

function assertValidTemplateSpec(spec: TemplateSpec): void {
  const violations = spec.validate();
  if (violations.length === 0) return;
  throw new InvalidTemplateSpecError(
    `invalid template spec: ${violations.map(formatTemplateSpecViolation).join("; ")}`,
  );
}

function formatTemplateSpecViolation(violation: TemplateSpecViolation): string {
  return `${violation.field}: ${violation.message}`;
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

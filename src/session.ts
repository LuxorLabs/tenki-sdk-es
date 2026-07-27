import { create } from "@bufbuild/protobuf";
import { durationFromMs, timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type Client } from "@connectrpc/connect";

import { DEFAULT_VOLUME_DETACH_TIMEOUT_MS, pollBackoffMs } from "./constants.js";
import { createDataPlaneClient, DataPlaneCredentialManager, type DataPlaneConfig } from "./data-plane.js";
import { dial, type DialOptions, type DialStream } from "./dial.js";
import {
  DataPlaneNotReadyError,
  dataPlaneNotReadyError,
  InvalidStateError,
  isDataPlaneEdgeNotReady,
  isPausedSessionStateError,
  mapError,
  ResumeFailedError,
  terminalDataPlaneNotReadyError,
} from "./errors.js";
import {
  list as listFs,
  mkdir as mkdirFs,
  readFileStream,
  remove as removeFs,
  stat as statFs,
  writeFileStream,
  type FileInfo,
  type ListOptions as FsListOptions,
  type ReadStreamOptions,
  type WriteStreamOptions,
} from "./fs.js";
import { Git } from "./git.js";
import type { SandboxSession } from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  AttachVolumeRequestSchema,
  CreateSessionCredentialRequestSchema,
  DataPlaneRouteStatus,
  DetachVolumeRequestSchema,
  ExposePortRequestSchema,
  ExtendSessionRequestSchema,
  GetSessionRequestSchema,
  GitOperationRequestSchema,
  ListExposedPortsRequestSchema,
  PauseSessionRequestSchema,
  SessionState as ProtoSessionState,
  ReadFileRequestSchema,
  ResumeSessionRequestSchema,
  SandboxService,
  SandboxSessionDataPlaneService,
  SandboxSessionDataPlaneServiceReadFileRequestSchema,
  SandboxSessionDataPlaneServiceStatRequestSchema,
  SandboxSessionDataPlaneServiceWriteFileRequestSchema,
  StatRequestSchema,
  TerminateSessionRequestSchema,
  UnexposePortRequestSchema,
  UpdateSessionRequestSchema,
  UpdateSSHAuthorizedKeysRequestSchema,
  VolumeMountSchema,
  WaitSessionRequestSchema,
  WriteFileRequestSchema,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { TemplateRuntimeState as ProtoTemplateRuntimeState } from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import type {
  DetachVolumeOptions,
  ExecOptions,
  ExposePortOptions,
  Output,
  UpdateSessionOptions,
  VolumeMountConfig,
} from "./options.js";
import { run, type ProcessRunHandle, type ProcessRunOptions } from "./process.js";
import { sleepReadyBackoff } from "./ready-backoff.js";
import { isRetryableStreamTransportError } from "./refused-stream.js";
import type { ExecResult } from "./result.js";
import { snapshotFromProto, type Snapshot } from "./snapshot.js";
import { connectSSH, type SSHConnection, type SSHConnectOptions } from "./ssh.js";
import { Stream } from "./stream.js";
import {
  exposeHostPortResilient,
  resilientHostPortTunnel,
  type ResilientHostPortTunnel,
  type ResilientHostPortTunnelOptions,
} from "./tunnel-resilient.js";
import { exposeHostPort, hostPortTunnel, type HostPortTunnel, type HostPortTunnelOptions } from "./tunnel.js";

// Tolerates stale stopped-state reads (read-replica lag) right after resume()
// before waitResumed has observed RESUMING from the server.
const RESUME_REVERT_GRACE_MS = 3_000;

export type SessionState =
  | "UNSPECIFIED"
  | "CREATING"
  | "RUNNING"
  | "PAUSED"
  | "USER_SHUTDOWN"
  | "PAUSING"
  | "RESUMING"
  | "TERMINATING"
  | "TERMINATED";

export type RuntimeState = "UNSPECIFIED" | "STARTING" | "READY" | "FAILED" | "STOPPED";

export interface ExposedPort {
  port: number;
  previewUrl: string;
  expiresAt?: Date;
  previewUrlId?: string;
  slug?: string;
}

export interface SessionHandle {
  readonly id: string;
  readonly rpcClient: Client<typeof SandboxService>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  stream(command: string, options?: ExecOptions): Promise<Stream>;
  gitOperation(operation: string, args: Record<string, string>): Promise<string>;
}

export interface SessionFs {
  readStream(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>>;
  writeStream(path: string, data: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<void>;
  stat(path: string): Promise<FileInfo>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string, options?: FsListOptions): Promise<FileInfo[]>;
}

export class Session implements SessionHandle, AsyncDisposable {
  readonly id: string;
  readonly rpcClient: Client<typeof SandboxService>;
  readonly git: Git;
  readonly fs: SessionFs;

  name: string;
  state: SessionState;
  ownerType: string;
  ownerId: string;
  workspaceId: string;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
  timeoutAt: Date;
  idleTimeoutMinutes?: number;
  lastActivityAt?: Date;
  pausedAt?: Date;
  pauseSnapshotId?: string;
  pauseRetentionMs?: number;
  pauseExpiresAt?: Date;
  metadata: Record<string, string>;
  tags: string[];
  volumeMounts: VolumeMountConfig[];
  pauseSnapshot?: Snapshot;
  lastResumeError?: string;
  terminalError?: string;
  runtimeState: RuntimeState;
  runtimeError?: string;
  sticky: boolean;
  public readonly sourceRegistryImageId?: string;
  public readonly sourceSnapshotId?: string;
  public readonly sourceRegistryWorkspaceId?: string;
  public readonly sourceRegistryRef?: string;
  public readonly sourceTemplateId?: string;

  private authToken: string;
  private gatewayAddress: string;
  private cookieName: string;
  private sshOptions?: SSHConnectOptions;
  private dataPlaneEndpoint = "";
  private dataPlaneWarmStarted = false;
  private dataPlaneCredential?: DataPlaneCredentialManager;
  private dataPlaneClient?: Client<typeof SandboxSessionDataPlaneService>;
  private dataPlaneVerifiedClient?: Client<typeof SandboxSessionDataPlaneService>;

  constructor(
    rpcClient: Client<typeof SandboxService>,
    proto: SandboxSession,
    authToken: string,
    gatewayAddress: string,
    cookieName: string,
    sshOptions?: SSHConnectOptions,
    private readonly dataPlaneReadyTimeoutMs = 60_000,
    dataPlane?: DataPlaneConfig,
  ) {
    this.rpcClient = rpcClient;
    this.authToken = authToken;
    this.gatewayAddress = gatewayAddress;
    this.cookieName = cookieName;
    this.sshOptions = sshOptions;
    this.applyDataPlaneResponse(dataPlane?.endpoint, dataPlane?.credential, dataPlane?.routeStatus);

    this.id = proto.id;
    this.name = proto.name;
    this.state = sessionStateFromProto(proto.state);
    this.ownerType = proto.ownerType;
    this.ownerId = proto.ownerId;
    this.workspaceId = proto.workspaceId;
    this.inboundEnabled = proto.inboundEnabled;
    this.outboundEnabled = proto.outboundEnabled;
    this.cpuCores = proto.cpuCores;
    this.memoryMb = proto.memoryMb;
    this.diskSizeGb = proto.diskSizeGb;
    this.timeoutAt = proto.timeoutAt ? timestampDate(proto.timeoutAt) : new Date(0);
    this.idleTimeoutMinutes = proto.idleTimeoutMinutes;
    this.lastActivityAt = proto.lastActivityAt ? timestampDate(proto.lastActivityAt) : undefined;
    this.pausedAt = proto.pausedAt ? timestampDate(proto.pausedAt) : undefined;
    this.pauseSnapshotId = proto.pauseSnapshotId;
    this.pauseRetentionMs = proto.pauseRetention
      ? Number(proto.pauseRetention.seconds) * 1000 + Math.floor(proto.pauseRetention.nanos / 1_000_000)
      : undefined;
    this.pauseExpiresAt = proto.pauseExpiresAt ? timestampDate(proto.pauseExpiresAt) : undefined;
    this.metadata = { ...proto.metadata };
    this.tags = [...(proto.tags ?? [])];
    this.pauseSnapshot = proto.pauseSnapshot ? snapshotFromProto(proto.pauseSnapshot) : undefined;
    this.volumeMounts = (proto.volumeAttachments ?? []).map((a) => ({
      volumeId: a.volumeId,
      mountPath: a.mountPath,
      readOnly: a.readonly,
    }));
    this.lastResumeError = proto.lastResumeError || undefined;
    this.terminalError = proto.terminalError || undefined;
    this.runtimeState = templateRuntimeStateFromProto(proto.runtimeState);
    this.runtimeError = proto.runtimeError || undefined;
    this.sticky = proto.sticky;
    this.sourceRegistryImageId = proto.sourceRegistryImageId || undefined;
    this.sourceSnapshotId = proto.sourceSnapshotId || undefined;
    this.sourceRegistryWorkspaceId = proto.sourceRegistryWorkspaceId || undefined;
    this.sourceRegistryRef = proto.sourceRegistryRef || undefined;
    this.sourceTemplateId = proto.sourceTemplateId || undefined;

    this.git = new Git(this);
    this.fs = {
      readStream: (path, options) => readFileStream(this, path, options),
      writeStream: (path, data, options) => writeFileStream(this, path, data, options),
      stat: (path) => statFs(this, path),
      mkdir: (path) => mkdirFs(this, path),
      remove: (path) => removeFs(this, path),
      list: (path, options) => listFs(this, path, options),
    };
  }

  dataPlaneRPC(): Client<typeof SandboxSessionDataPlaneService> | undefined {
    return this.dataPlaneClient;
  }

  dataPlaneReadyBudgetMs(): number {
    return this.dataPlaneReadyTimeoutMs;
  }

  // Bootstrap the data-plane client via CreateSessionCredential if not resolved yet.
  async ensureDataPlane(): Promise<Client<typeof SandboxSessionDataPlaneService> | undefined> {
    if (!this.dataPlaneClient) await this.renewDataPlaneCredential();
    if (this.dataPlaneClient) await this.ensureDataPlaneServing(this.dataPlaneClient);
    return this.dataPlaneClient;
  }

  async requireDataPlane(): Promise<Client<typeof SandboxSessionDataPlaneService>> {
    const dataPlane = await this.ensureDataPlane();
    if (!dataPlane) throw new Error("sandbox: data-plane endpoint unavailable");
    return dataPlane;
  }

  // Probe the edge until it stops returning the transient cold-start 404 (Edge applies the route async).
  private async ensureDataPlaneServing(client: Client<typeof SandboxSessionDataPlaneService>): Promise<void> {
    if (this.dataPlaneVerifiedClient === client) return;
    let lastErr: unknown;
    const deadline = Date.now() + this.dataPlaneReadyTimeoutMs;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      try {
        await client.stat(
          create(SandboxSessionDataPlaneServiceStatRequestSchema, {
            request: create(StatRequestSchema, { sessionId: this.id, path: "/home/tenki" }),
          }),
        );
        this.dataPlaneVerifiedClient = client;
        return;
      } catch (err) {
        // Any response other than edge-not-ready (success OR an app-level error) proves the route serves.
        if (!isDataPlaneEdgeNotReady(err)) {
          this.dataPlaneVerifiedClient = client;
          return;
        }
        lastErr = err;
        await sleepReadyBackoff(attempt, deadline);
      }
    }
    throw dataPlaneNotReadyError(lastErr);
  }

  async reauthOnUnauthenticated(err: unknown): Promise<boolean> {
    if (!(err instanceof ConnectError) || err.code !== Code.Unauthenticated) return false;
    try {
      return await this.renewDataPlaneCredential();
    } catch {
      return false;
    }
  }

  private configureDataPlane(dataPlane?: DataPlaneConfig): void {
    const endpoint = dataPlane?.endpoint?.trim();
    if (!endpoint) return;
    if (endpoint === this.dataPlaneEndpoint && this.dataPlaneCredential) {
      this.dataPlaneCredential.set(dataPlane?.credential);
      return;
    }
    this.dataPlaneCredential?.stop();
    this.dataPlaneEndpoint = endpoint;
    this.dataPlaneCredential = new DataPlaneCredentialManager(this, dataPlane?.credential);
    this.dataPlaneClient = createDataPlaneClient(endpoint, this.dataPlaneCredential);
  }

  private resetDataPlane(): void {
    this.dataPlaneCredential?.stop();
    this.dataPlaneEndpoint = "";
    this.dataPlaneCredential = undefined;
    this.dataPlaneClient = undefined;
    this.dataPlaneVerifiedClient = undefined;
    this.dataPlaneWarmStarted = false;
  }

  private applyDataPlaneResponse(
    endpoint?: string,
    credential?: DataPlaneConfig["credential"],
    routeStatus?: DataPlaneRouteStatus,
  ): void {
    if (routeStatus === DataPlaneRouteStatus.FAILED) return;
    this.configureDataPlane({ endpoint, credential });
    if (routeStatus === DataPlaneRouteStatus.VERIFIED && this.dataPlaneClient) {
      this.dataPlaneVerifiedClient = this.dataPlaneClient;
      return;
    }
    this.startDataPlaneWarm();
  }

  // Open the connection once an endpoint is known so the first call skips the handshake. The request may be
  // rejected (no credential yet); the pooled connection is the point, so this must not mark the client verified.
  private startDataPlaneWarm(): void {
    if (this.dataPlaneWarmStarted || !this.dataPlaneClient) return;
    this.dataPlaneWarmStarted = true;
    const client = this.dataPlaneClient;
    void (async () => {
      try {
        await client.stat(
          create(SandboxSessionDataPlaneServiceStatRequestSchema, {
            request: create(StatRequestSchema, { sessionId: this.id, path: "/home/tenki" }),
          }),
          { headers: { "X-Tenki-Dataplane-Probe": "warmup" } },
        );
      } catch {
        // Any outcome means the connection was established, which is all the warm needs.
      }
    })();
  }

  async renewDataPlaneCredential(): Promise<boolean> {
    const deadline = Date.now() + this.dataPlaneReadyTimeoutMs;
    let lastErr: unknown;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      try {
        const resp = await this.rpcClient.createSessionCredential(
          create(CreateSessionCredentialRequestSchema, { sessionId: this.id }),
        );
        switch (resp.routeStatus) {
          case DataPlaneRouteStatus.FAILED:
            throw terminalDataPlaneNotReadyError();
          case DataPlaneRouteStatus.NOT_READY:
            lastErr = dataPlaneNotReadyError(undefined);
            await sleepReadyBackoff(attempt, deadline);
            continue;
          default:
            if (resp.dataPlaneEndpoint?.trim()) {
              this.applyDataPlaneResponse(resp.dataPlaneEndpoint, resp.credential, resp.routeStatus);
            } else {
              this.dataPlaneCredential?.set(resp.credential);
            }
            return true;
        }
      } catch (err) {
        const mapped = mapError(err);
        if (mapped instanceof DataPlaneNotReadyError || mapped instanceof InvalidStateError) {
          if (isPausedSessionStateError(mapped)) throw mapped;
          if (mapped instanceof DataPlaneNotReadyError && mapped.terminal) throw mapped;
          lastErr = mapped;
          await sleepReadyBackoff(attempt, deadline);
          continue;
        }
        throw mapped;
      }
    }
    throw dataPlaneNotReadyError(lastErr);
  }

  private applyProto(proto: SandboxSession): void {
    this.name = proto.name;
    this.state = sessionStateFromProto(proto.state);
    this.ownerType = proto.ownerType;
    this.ownerId = proto.ownerId;
    this.workspaceId = proto.workspaceId;
    this.inboundEnabled = proto.inboundEnabled;
    this.outboundEnabled = proto.outboundEnabled;
    this.cpuCores = proto.cpuCores;
    this.memoryMb = proto.memoryMb;
    this.diskSizeGb = proto.diskSizeGb;
    this.timeoutAt = proto.timeoutAt ? timestampDate(proto.timeoutAt) : new Date(0);
    this.idleTimeoutMinutes = proto.idleTimeoutMinutes;
    this.lastActivityAt = proto.lastActivityAt ? timestampDate(proto.lastActivityAt) : undefined;
    this.pausedAt = proto.pausedAt ? timestampDate(proto.pausedAt) : undefined;
    this.pauseSnapshotId = proto.pauseSnapshotId;
    this.pauseRetentionMs = proto.pauseRetention
      ? Number(proto.pauseRetention.seconds) * 1000 + Math.floor(proto.pauseRetention.nanos / 1_000_000)
      : undefined;
    this.pauseExpiresAt = proto.pauseExpiresAt ? timestampDate(proto.pauseExpiresAt) : undefined;
    this.metadata = { ...proto.metadata };
    this.tags = [...(proto.tags ?? [])];
    this.pauseSnapshot = proto.pauseSnapshot ? snapshotFromProto(proto.pauseSnapshot) : undefined;
    this.volumeMounts = (proto.volumeAttachments ?? []).map((a) => ({
      volumeId: a.volumeId,
      mountPath: a.mountPath,
      readOnly: a.readonly,
    }));
    this.lastResumeError = proto.lastResumeError || undefined;
    this.terminalError = proto.terminalError || undefined;
    this.runtimeState = templateRuntimeStateFromProto(proto.runtimeState);
    this.runtimeError = proto.runtimeError || undefined;
    this.sticky = proto.sticky;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const proc = run(this, [command, ...(options?.args ?? [])], {
      cwd: options?.cwd,
      env: options?.env,
      stdin: undefined,
    });
    void proc.stdin.close().catch(() => {});
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const outputs: Output[] = [];

    await Promise.all([
      collectReadableOutputs(proc.stdout, false, stdoutChunks, outputs, options?.onOutput),
      collectReadableOutputs(proc.stderr, true, stderrChunks, outputs, options?.onOutput),
    ]);

    const result = await proc;
    return {
      sessionId: this.id,
      command,
      args: options?.args ?? [],
      status: result.exitCode === 0 && !result.signal ? "SUCCEEDED" : "FAILED",
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? 0,
      outputs,
      stdout: concatUint8Arrays(stdoutChunks),
      stderr: concatUint8Arrays(stderrChunks),
    };
  }

  async stream(command: string, options?: ExecOptions): Promise<Stream> {
    if (options?.onOutput) {
      throw new Error("Session.stream does not support onOutput; consume chunks with stream.next() instead");
    }
    const proc = run(this, [command, ...(options?.args ?? [])], { cwd: options?.cwd, env: options?.env });
    await proc.pid;
    void proc.stdin.close().catch(() => {});
    return streamFromRunHandle(this.id, command, options?.args ?? [], proc);
  }

  dial(unixSocketPath: string, options?: DialOptions): Promise<DialStream> {
    return dial(this, unixSocketPath, options);
  }

  run(argv: string[], options?: ProcessRunOptions): ProcessRunHandle {
    return run(this, argv, options);
  }

  readFileStream(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>> {
    return readFileStream(this, path, options);
  }

  writeFileStream(path: string, data: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<void> {
    return writeFileStream(this, path, data, options);
  }

  stat(path: string): Promise<FileInfo> {
    return statFs(this, path);
  }

  mkdir(path: string): Promise<void> {
    return mkdirFs(this, path);
  }

  remove(path: string): Promise<void> {
    return removeFs(this, path);
  }

  list(path: string, options?: FsListOptions): Promise<FileInfo[]> {
    return listFs(this, path, options);
  }

  hostPortTunnel(host: string, port: number, options?: HostPortTunnelOptions): Promise<HostPortTunnel> {
    return hostPortTunnel(this, host, port, options);
  }

  resilientHostPortTunnel(
    host: string,
    port: number,
    options?: ResilientHostPortTunnelOptions,
  ): Promise<ResilientHostPortTunnel> {
    return resilientHostPortTunnel(this, host, port, options);
  }

  exposeHostPort(hostAddr: string, options?: HostPortTunnelOptions): Promise<HostPortTunnel> {
    return exposeHostPort(this, hostAddr, options);
  }

  exposeHostPortResilient(
    hostAddr: string,
    options?: ResilientHostPortTunnelOptions,
  ): Promise<ResilientHostPortTunnel> {
    return exposeHostPortResilient(this, hostAddr, options);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
    try {
      const request = create(WriteFileRequestSchema, {
        sessionId: this.id,
        path,
        content,
      });
      const dataPlane = await this.requireDataPlane();
      await dataPlane.writeFile(create(SandboxSessionDataPlaneServiceWriteFileRequestSchema, { request }));
    } catch (err) {
      throw mapError(err);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      const request = create(ReadFileRequestSchema, { sessionId: this.id, path });
      const dataPlane = await this.requireDataPlane();
      const resp = (await dataPlane.readFile(create(SandboxSessionDataPlaneServiceReadFileRequestSchema, { request })))
        .response!;
      return new Uint8Array(resp.content);
    } catch (err) {
      throw mapError(err);
    }
  }

  async waitReady(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const timeout = timeoutMs ?? 180_000;
    const deadline = Date.now() + timeout;
    try {
      await this.waitReadyStream(timeout, signal);
      return;
    } catch (err) {
      const unimplemented = err instanceof ConnectError && err.code === Code.Unimplemented;
      if (!unimplemented && !isRetryableStreamTransportError(err)) throw mapError(err);
    }
    await this.waitReadyPoll(Math.max(0, deadline - Date.now()), signal);
  }

  private async waitReadyStream(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    for await (const resp of this.rpcClient.waitSession(create(WaitSessionRequestSchema, { sessionId: this.id }), {
      timeoutMs,
      signal,
    })) {
      signal?.throwIfAborted();
      if (resp.session) this.applyProto(resp.session);
      this.applyDataPlaneResponse(resp.dataPlaneEndpoint, resp.credential, resp.routeStatus);
      if (isReady(this.state)) return;
      if (isTerminal(this.state)) {
        throw this.terminalStateError();
      }
    }
    if (isReady(this.state)) return;
    if (isTerminal(this.state)) {
      throw this.terminalStateError();
    }
    throw new Error(`timeout waiting for session ${this.id} to become ready`);
  }

  private async waitReadyPoll(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? 180_000);
    let attempt = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const resp = await this.rpcClient.getSession(create(GetSessionRequestSchema, { sessionId: this.id }));
        if (resp.session) this.applyProto(resp.session);
      } catch {
        // tolerate not-found during polling (read-replica lag)
      }
      if (isReady(this.state)) return;
      if (isTerminal(this.state)) {
        throw this.terminalStateError();
      }
      await sleep(pollBackoffMs(attempt), signal);
      attempt++;
    }
    throw new Error(`timeout waiting for session ${this.id} to become ready`);
  }

  /**
   * Wait until an in-flight resume reaches RUNNING or fails.
   *
   * Unlike waitReady — which only treats TERMINATED/TERMINATING as terminal
   * and would spin until timeout — a session that reverts from RESUMING back
   * to a stopped state (PAUSED/USER_SHUTDOWN) throws ResumeFailedError
   * carrying the server-side lastResumeError.
   */
  async waitResumed(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? 180_000);
    const start = Date.now();
    let sawResuming = false;
    let attempt = 0;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const resp = await this.rpcClient.getSession(create(GetSessionRequestSchema, { sessionId: this.id }));
        if (resp.session) this.applyProto(resp.session);
      } catch {
        // tolerate not-found during polling (read-replica lag)
      }
      if (isReady(this.state)) return;
      if (isTerminal(this.state)) throw this.terminalStateError();
      if (this.state === "RESUMING") {
        sawResuming = true;
      } else if (this.state === "PAUSED" || this.state === "USER_SHUTDOWN") {
        // A stopped state is a resume failure once RESUMING was observed from
        // the server, or after the replica-lag grace window has passed.
        if (sawResuming || Date.now() - start > RESUME_REVERT_GRACE_MS) {
          throw this.resumeFailedError();
        }
      }
      await sleep(pollBackoffMs(attempt), signal);
      attempt++;
    }
    throw new Error(`timeout waiting for session ${this.id} to resume`);
  }

  private resumeFailedError(): Error {
    const suffix = this.lastResumeError ? `: ${this.lastResumeError}` : "";
    return new ResumeFailedError(`resume failed: session ${this.id} reverted to ${this.state}${suffix}`);
  }

  private terminalStateError(): Error {
    const suffix = this.terminalError ? `: ${this.terminalError}` : "";
    return new Error(`session entered terminal state: ${this.state}${suffix}`);
  }

  async close(): Promise<void> {
    this.dataPlaneCredential?.stop();
    try {
      const resp = await this.rpcClient.terminateSession(create(TerminateSessionRequestSchema, { sessionId: this.id }));
      if (resp.session) this.applyProto(resp.session);
    } catch (err) {
      throw mapError(err);
    }
  }

  async closeIfOpen(): Promise<void> {
    if (isTerminal(this.state)) return;
    await this.close();
  }

  async extend(additionalMs: number): Promise<void> {
    try {
      const resp = await this.rpcClient.extendSession(
        create(ExtendSessionRequestSchema, {
          sessionId: this.id,
          additionalDuration: durationFromMs(additionalMs),
        }),
      );
      if (resp.session) this.applyProto(resp.session);
    } catch (err) {
      throw mapError(err);
    }
  }

  async refresh(): Promise<void> {
    try {
      const resp = await this.rpcClient.getSession(create(GetSessionRequestSchema, { sessionId: this.id }));
      if (resp.session) this.applyProto(resp.session);
    } catch (err) {
      throw mapError(err);
    }
  }

  async exposePort(port: number, options?: ExposePortOptions): Promise<ExposedPort> {
    const req = create(ExposePortRequestSchema, {
      sessionId: this.id,
      port,
    });
    if (options?.ttlMs && options.ttlMs > 0) {
      req.expiresAt = timestampFromDate(new Date(Date.now() + options.ttlMs));
    }
    if (options?.slug?.trim()) {
      req.slug = options.slug.trim();
    }
    try {
      const resp = await this.rpcClient.exposePort(req);
      return {
        port: resp.port,
        previewUrl: resp.previewUrl,
        expiresAt: resp.expiresAt ? timestampDate(resp.expiresAt) : undefined,
        previewUrlId: resp.previewUrlId,
        slug: resp.slug,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async unexposePort(port: number): Promise<void> {
    try {
      await this.rpcClient.unexposePort(create(UnexposePortRequestSchema, { sessionId: this.id, port }));
    } catch (err) {
      throw mapError(err);
    }
  }

  async listExposedPorts(): Promise<ExposedPort[]> {
    try {
      const resp = await this.rpcClient.listExposedPorts(create(ListExposedPortsRequestSchema, { sessionId: this.id }));
      return (resp.ports ?? []).map((p) => ({
        port: p.port,
        previewUrl: p.previewUrl,
        expiresAt: p.expiresAt ? timestampDate(p.expiresAt) : undefined,
        previewUrlId: p.previewUrlId,
        slug: p.slug,
      }));
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateSshAuthorizedKeys(keys: string[]): Promise<void> {
    try {
      await this.rpcClient.updateSSHAuthorizedKeys(
        create(UpdateSSHAuthorizedKeysRequestSchema, {
          sessionId: this.id,
          sshAuthorizedKeys: [...keys],
        }),
      );
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateTags(tags: string[]): Promise<void> {
    await this.update({ tags });
  }

  async update(options: UpdateSessionOptions): Promise<void> {
    try {
      const updateReq: Record<string, unknown> = { sessionId: this.id };
      if (options.name !== undefined) updateReq.name = options.name;
      if (options.tags !== undefined) {
        const normalized = normalizeTags(options.tags);
        if (normalized.length === 0) {
          updateReq.clearTags = true;
        } else {
          updateReq.tags = normalized;
        }
      }
      if (options.sticky !== undefined) updateReq.sticky = options.sticky;
      const resp = await this.rpcClient.updateSession(create(UpdateSessionRequestSchema, updateReq));
      if (resp.session) this.applyProto(resp.session);
    } catch (err) {
      throw mapError(err);
    }
  }

  async attachVolume(volumeId: string, mountPath: string, options?: { readOnly?: boolean }): Promise<void> {
    try {
      const resp = await this.rpcClient.attachVolume(
        create(AttachVolumeRequestSchema, {
          sessionId: this.id,
          volume: create(VolumeMountSchema, {
            volumeId,
            mountPath,
            readonly: options?.readOnly ?? false,
          }),
        }),
      );
      if (resp.attachment) {
        this.volumeMounts.push({
          volumeId: resp.attachment.volumeId,
          mountPath: resp.attachment.mountPath,
          readOnly: resp.attachment.readonly,
        });
      }
    } catch (err) {
      throw mapError(err);
    }
  }

  async detachVolume(volumeId: string, options?: DetachVolumeOptions): Promise<void> {
    try {
      await this.rpcClient.detachVolume(
        create(DetachVolumeRequestSchema, {
          sessionId: this.id,
          volumeId,
          forceDetach: options?.force ?? false,
        }),
      );
    } catch (err) {
      throw mapError(err);
    }

    const waitTimeout = options?.waitTimeoutMs ?? DEFAULT_VOLUME_DETACH_TIMEOUT_MS;
    if (waitTimeout > 0) {
      const deadline = Date.now() + waitTimeout;
      let attempt = 0;
      while (Date.now() < deadline) {
        options?.signal?.throwIfAborted();
        await this.refresh();
        const attachment = this.volumeMounts.find((v) => v.volumeId === volumeId);
        if (!attachment) break;
        await sleep(pollBackoffMs(attempt), options?.signal);
        attempt++;
      }
    }

    this.volumeMounts = this.volumeMounts.filter((v) => v.volumeId !== volumeId);
  }

  async gitOperation(operation: string, args: Record<string, string>): Promise<string> {
    try {
      const resp = await this.rpcClient.gitOperation(
        create(GitOperationRequestSchema, {
          sessionId: this.id,
          operation,
          args,
        }),
      );
      return resp.output;
    } catch (err) {
      throw mapError(err);
    }
  }

  async ssh(signal?: AbortSignal): Promise<SSHConnection> {
    return connectSSH(this.gatewayAddress, this.id, this.authToken, this.cookieName, this.sshOptions);
  }

  async pause(): Promise<void> {
    try {
      const resp = await this.rpcClient.pauseSession(create(PauseSessionRequestSchema, { sessionId: this.id }));
      if (resp.session) this.applyProto(resp.session);
      this.resetDataPlane();
    } catch (err) {
      throw mapError(err);
    }
  }

  async resume(): Promise<void> {
    try {
      const resp = await this.rpcClient.resumeSession(create(ResumeSessionRequestSchema, { sessionId: this.id }));
      if (resp.session) this.applyProto(resp.session);
      this.resetDataPlane();
    } catch (err) {
      throw mapError(err);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.closeIfOpen();
  }
}

function sessionStateFromProto(state: ProtoSessionState): SessionState {
  switch (state) {
    case ProtoSessionState.CREATING:
      return "CREATING";
    case ProtoSessionState.RUNNING:
      return "RUNNING";
    case ProtoSessionState.PAUSED:
      return "PAUSED";
    case ProtoSessionState.USER_SHUTDOWN:
      return "USER_SHUTDOWN";
    case ProtoSessionState.PAUSING:
      return "PAUSING";
    case ProtoSessionState.RESUMING:
      return "RESUMING";
    case ProtoSessionState.TERMINATING:
      return "TERMINATING";
    case ProtoSessionState.TERMINATED:
      return "TERMINATED";
    default:
      return "UNSPECIFIED";
  }
}

function templateRuntimeStateFromProto(state: ProtoTemplateRuntimeState): RuntimeState {
  switch (state) {
    case ProtoTemplateRuntimeState.STARTING:
      return "STARTING";
    case ProtoTemplateRuntimeState.READY:
      return "READY";
    case ProtoTemplateRuntimeState.FAILED:
      return "FAILED";
    case ProtoTemplateRuntimeState.STOPPED:
      return "STOPPED";
    default:
      return "UNSPECIFIED";
  }
}

/** Returns true if the session can accept commands. */
export function isReady(state: SessionState): boolean {
  return state === "RUNNING";
}

export function isTerminal(state: SessionState): boolean {
  return state === "TERMINATED" || state === "TERMINATING";
}

function streamFromRunHandle(sessionId: string, command: string, args: string[], proc: ProcessRunHandle): Stream {
  const controller = new AbortController();
  const stream = new Stream(controller);

  void pumpRunReadable(stream, proc.stdout, false);
  void pumpRunReadable(stream, proc.stderr, true);
  void (async () => {
    try {
      const result = await proc;
      stream.finish({
        sessionId,
        command,
        args,
        status: result.exitCode === 0 && !result.signal ? "SUCCEEDED" : "FAILED",
        exitCode: result.exitCode,
        durationMs: result.durationMs ?? 0,
        outputs: [],
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (err) {
      stream.fail(err);
    }
  })();
  controller.signal.addEventListener("abort", () => {
    void proc.kill();
  });
  return stream;
}

async function pumpRunReadable(stream: Stream, readable: ReadableStream<Uint8Array>, isStderr: boolean): Promise<void> {
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    stream.push({ data: value, isStderr, isFinal: false });
  }
}

async function* streamReadableOutputs(readable: ReadableStream<Uint8Array>, isStderr: boolean) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { data: value, isStderr, isFinal: false };
    }
  } finally {
    reader.releaseLock();
  }
}

async function collectReadableOutputs(
  readable: ReadableStream<Uint8Array>,
  isStderr: boolean,
  chunks: Uint8Array[],
  outputs: Output[],
  onOutput?: (output: Output) => void,
): Promise<void> {
  for await (const output of streamReadableOutputs(readable, isStderr)) {
    onOutput?.(output);
    outputs.push(output);
    chunks.push(new Uint8Array(output.data));
  }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array();
  if (arrays.length === 1) return arrays[0];
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

function normalizeTags(tags: string[]): string[] {
  return tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
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

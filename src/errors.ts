import { Code, ConnectError } from "@connectrpc/connect";

export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxError";
  }
}

export class PaginationStalledError extends SandboxError {
  name = "PaginationStalledError";
}

export class MissingAuthTokenError extends SandboxError {
  constructor() {
    super("missing auth token - set TENKI_AUTH_TOKEN or TENKI_API_KEY or use authToken option");
    this.name = "MissingAuthTokenError";
  }
}

export class InvalidAuthTokenError extends SandboxError {
  constructor() {
    super("invalid auth token - API keys and service tokens must start with tk_");
    this.name = "InvalidAuthTokenError";
  }
}

export class SessionNotFoundError extends SandboxError {
  name = "SessionNotFoundError";
}
export class SessionExpiredError extends SandboxError {
  name = "SessionExpiredError";
}
export class SessionTerminatedError extends SandboxError {
  name = "SessionTerminatedError";
  readonly retryable = true;
  readonly terminationCause?: string;

  constructor(message: string, options?: ErrorOptions & { terminationCause?: string }) {
    super(message, options);
    this.terminationCause = options?.terminationCause;
  }
}
export class FileNotFoundError extends SandboxError {
  name = "FileNotFoundError";
}
export class InvalidStateError extends SandboxError {
  name = "InvalidStateError";
}
export class CommandTimeoutError extends SandboxError {
  name = "CommandTimeoutError";
}
export class UnauthorizedError extends SandboxError {
  name = "UnauthorizedError";
}
export class PermissionDeniedError extends SandboxError {
  name = "PermissionDeniedError";
}
export class QuotaExceededError extends SandboxError {
  name = "QuotaExceededError";
}
export class CapacityUnavailableError extends SandboxError {
  name = "CapacityUnavailableError";
}
export class PortLimitExceededError extends SandboxError {
  name = "PortLimitExceededError";
}
export class InboundDisabledError extends SandboxError {
  name = "InboundDisabledError";
}
export class SSHUnavailableError extends SandboxError {
  name = "SSHUnavailableError";
}
export class RateLimitedError extends SandboxError {
  name = "RateLimitedError";
}
export class VolumeNotFoundError extends SandboxError {
  name = "VolumeNotFoundError";
}
export class VolumeInUseError extends SandboxError {
  name = "VolumeInUseError";
}
export class VolumeSyncPendingError extends SandboxError {
  name = "VolumeSyncPendingError";
}
export class VolumeLimitExceededError extends SandboxError {
  name = "VolumeLimitExceededError";
}
// GitOperationFailedError classifies an in-guest git failure surfaced by
// node-agent as FailedPrecondition.
export class GitOperationFailedError extends SandboxError {
  name = "GitOperationFailedError";
  constructor(
    message: string,
    readonly stderr: string = "",
    readonly exitCode: number | undefined = undefined,
    readonly retryable: boolean = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export class StreamClosedError extends SandboxError {
  name = "StreamClosedError";
}
export class InvalidResourceConfigError extends SandboxError {
  name = "InvalidResourceConfigError";
}
export class SnapshotNotFoundError extends SandboxError {
  name = "SnapshotNotFoundError";
}
export class SnapshotFailedError extends SandboxError {
  name = "SnapshotFailedError";
}
export class SnapshotNotDurableError extends SandboxError {
  name = "SnapshotNotDurableError";
}
export class ResumeFailedError extends SandboxError {
  name = "ResumeFailedError";
}
export class PauseFailedError extends SandboxError {
  name = "PauseFailedError";
}
export class TemplateNotFoundError extends SandboxError {
  name = "TemplateNotFoundError";
}
export class RegistryImageNotFoundError extends SandboxError {
  name = "RegistryImageNotFoundError";
}
export class TemplateExistsError extends SandboxError {
  name = "TemplateExistsError";
}
export class TemplateBuildNotFoundError extends SandboxError {
  name = "TemplateBuildNotFoundError";
}
export class TemplateBuildFailedError extends SandboxError {
  name = "TemplateBuildFailedError";
  readonly build?: import("./template.js").TemplateBuild;

  constructor(message: string, options?: ErrorOptions);
  constructor(message: string, build?: import("./template.js").TemplateBuild, options?: ErrorOptions);
  constructor(
    message: string,
    buildOrOptions?: import("./template.js").TemplateBuild | ErrorOptions,
    options?: ErrorOptions,
  ) {
    const build = buildOrOptions && "state" in buildOrOptions ? buildOrOptions : undefined;
    const errorOptions = build ? options : (buildOrOptions as ErrorOptions | undefined);
    super(message, errorOptions);
    this.build = build;
  }
}
export class TemplateBuildInProgressError extends SandboxError {
  name = "TemplateBuildInProgressError";
}

export class InvalidTemplateSpecError extends SandboxError {
  name = "InvalidTemplateSpecError";
}

export class TemplateRuntimeFailedError extends SandboxError {
  name = "TemplateRuntimeFailedError";

  constructor(
    message: string,
    public readonly session: import("./session.js").Session,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A readiness wait failed after the server admitted the session. */
export class WaitReadyFailedError extends SandboxError {
  name = "WaitReadyFailedError";

  constructor(
    message: string,
    public readonly session: import("./session.js").Session,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class CapabilityUnavailableError extends SandboxError {
  name = "CapabilityUnavailableError";

  constructor(
    public readonly primitive: string,
    message = `sandbox capability unavailable: ${primitive}`,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DataPlaneNotReadyError extends SandboxError {
  name = "DataPlaneNotReadyError";
  readonly retryable: boolean;

  constructor(message = "sandbox: data-plane edge route not ready", options?: ErrorOptions & { terminal?: boolean }) {
    super(message, options);
    this.terminal = options?.terminal ?? false;
    this.retryable = !this.terminal;
  }

  readonly terminal: boolean;
}

export function isDataPlaneEdgeNotReady(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.Unimplemented && /\b404\b/.test(err.message ?? "");
}

export function isPausedSessionStateError(err: unknown): boolean {
  if (!(err instanceof InvalidStateError)) return false;
  return /\bstate\s*=\s*PAUSED\b/i.test(err.message);
}

export function dataPlaneNotReadyError(err: unknown): DataPlaneNotReadyError {
  return new DataPlaneNotReadyError("sandbox: data-plane edge route not ready", {
    cause: err instanceof Error ? err : undefined,
  });
}

export function terminalDataPlaneNotReadyError(err?: unknown): DataPlaneNotReadyError {
  return new DataPlaneNotReadyError("sandbox: data-plane route verification failed", {
    cause: err instanceof Error ? err : undefined,
    terminal: true,
  });
}

export class PrimitiveTimeoutError extends CapabilityUnavailableError {
  name = "PrimitiveTimeoutError";

  constructor(
    primitive: string,
    message = `sandbox ${primitive} timed out waiting for guest-agent reply`,
    options?: ErrorOptions,
  ) {
    super(primitive, message, options);
  }
}

// Platform-teardown exit reasons, formatted `session_terminated:<cause>[: detail]`
// by node-agent — see the matching block in errors.py / run.go.
export const SESSION_TERMINATED_REASON_PREFIX = "session_terminated";

export function isSessionTerminatedReason(reason: string): boolean {
  return reason.startsWith(SESSION_TERMINATED_REASON_PREFIX);
}

/** Extracts the cause token from a `session_terminated:<cause>[: detail]` reason. */
export function sessionTerminationCause(reason: string): string {
  if (!reason.startsWith(`${SESSION_TERMINATED_REASON_PREFIX}:`)) return "";
  return reason
    .slice(SESSION_TERMINATED_REASON_PREFIX.length + 1)
    .split(":", 1)[0]!
    .trim();
}

// Git failure classification — see the matching block in errors.go / errors.py.
const GIT_FAILURE = /git .*failed \(exit_code=/i;
const GIT_EXIT_CODE = /\(exit_code=(\d+)\)/;
const GIT_STDERR = /; check the repository, ref and access token: ([\s\S]+)/;
const TRANSIENT_GIT =
  /Recv failure|Connection reset by peer|Could not resolve host|Failed to connect|Connection timed out|TLS|gnutls_handshake|SSL_ERROR|RPC failed|HTTP 5\d\d|\b(429|503)\b|early EOF|remote end hung up unexpectedly|unexpected disconnect/i;
const TERMINAL_GIT =
  /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|fatal: repository .* not found|Permission denied|\b403\b|invalid credentials|pathspec|did not match any/i;

export function mapError(err: unknown): SandboxError {
  if (err instanceof SandboxError) return err;

  const connectErr =
    err instanceof ConnectError ? err : ConnectError.from(err) instanceof ConnectError ? ConnectError.from(err) : null;

  if (!connectErr || !(connectErr instanceof ConnectError)) {
    return new SandboxError(err instanceof Error ? err.message : String(err), {
      cause: err instanceof Error ? err : undefined,
    });
  }
  if (isDataPlaneEdgeNotReady(connectErr)) {
    return dataPlaneNotReadyError(connectErr);
  }

  const msg = connectErr.message.toLowerCase();
  const cause = connectErr;

  switch (connectErr.code) {
    case Code.Unauthenticated:
      return new UnauthorizedError(connectErr.message, { cause });
    case Code.PermissionDenied:
      return new PermissionDeniedError(connectErr.message, { cause });
    case Code.NotFound:
      if (msg.includes("template build")) return new TemplateBuildNotFoundError(connectErr.message, { cause });
      if (msg.includes("template")) return new TemplateNotFoundError(connectErr.message, { cause });
      if (msg.includes("registry image")) return new RegistryImageNotFoundError(connectErr.message, { cause });
      if (msg.includes("snapshot")) return new SnapshotNotFoundError(connectErr.message, { cause });
      if (msg.includes("volume")) return new VolumeNotFoundError(connectErr.message, { cause });
      if (msg.includes("artifact")) return new SessionExpiredError(connectErr.message, { cause });
      if (msg.includes("no such file or directory")) return new FileNotFoundError(connectErr.message, { cause });
      return new SessionNotFoundError(connectErr.message, { cause });
    case Code.AlreadyExists:
      if (msg.includes("template")) return new TemplateExistsError(connectErr.message, { cause });
      return new SandboxError(connectErr.message, { cause });
    case Code.DeadlineExceeded:
      return new CommandTimeoutError(connectErr.message, { cause });
    case Code.ResourceExhausted:
      if (msg.includes("maximum exposed ports")) return new PortLimitExceededError(connectErr.message, { cause });
      if (msg.includes("volume")) return new VolumeLimitExceededError(connectErr.message, { cause });
      if (msg.includes("rate limit")) return new RateLimitedError(connectErr.message, { cause });
      if (msg.includes("capacity")) return new CapacityUnavailableError(connectErr.message, { cause });
      return new QuotaExceededError(connectErr.message, { cause });
    case Code.FailedPrecondition:
      if (msg.includes("snapshot not yet durable")) {
        return new SnapshotNotDurableError(connectErr.message, { cause });
      }
      if (msg.includes("template build already in progress") || msg.includes("build in progress"))
        return new TemplateBuildInProgressError(connectErr.message, { cause });
      if (msg.includes("terminated")) return new SessionTerminatedError(connectErr.message, { cause });
      if (GIT_FAILURE.test(connectErr.message)) {
        const fullMessage = connectErr.message;
        const exitMatch = GIT_EXIT_CODE.exec(fullMessage);
        const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : undefined;
        const stderrMatch = GIT_STDERR.exec(fullMessage);
        const stderr = stderrMatch ? stderrMatch[1] : "";
        const retryable = TRANSIENT_GIT.test(fullMessage) && !TERMINAL_GIT.test(fullMessage);
        return new GitOperationFailedError(fullMessage, stderr, exitCode, retryable, { cause });
      }
      if (msg.includes("sync_pending") || msg.includes("sync pending"))
        return new VolumeSyncPendingError(connectErr.message, { cause });
      if (msg.includes("volume is attached") || msg.includes("volume is in use"))
        return new VolumeInUseError(connectErr.message, { cause });
      if (msg.includes("inbound access is disabled")) return new InboundDisabledError(connectErr.message, { cause });
      if (msg.includes("ssh")) return new SSHUnavailableError(connectErr.message, { cause });
      return new InvalidStateError(connectErr.message, { cause });
    case Code.Unavailable:
      if (msg.includes("ssh")) return new SSHUnavailableError(connectErr.message, { cause });
      return new SandboxError(connectErr.message, { cause });
    default:
      return new SandboxError(connectErr.message, { cause });
  }
}

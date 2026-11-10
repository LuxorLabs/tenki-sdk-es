import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import {
  CapacityUnavailableError,
  CommandTimeoutError,
  DataPlaneNotReadyError,
  GitOperationFailedError,
  InboundDisabledError,
  InvalidStateError,
  mapError,
  PermissionDeniedError,
  PortLimitExceededError,
  QuotaExceededError,
  RateLimitedError,
  RegistryImageNotFoundError,
  ResumeFailedError,
  SandboxError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionTerminatedError,
  SnapshotNotDurableError,
  SnapshotNotFoundError,
  SSHUnavailableError,
  StorageConnectionDisabledError,
  StorageConnectionNotFoundError,
  StorageMountAttachCancelledError,
  StorageMountNotFoundError,
  TemplateBuildFailedError,
  TemplateBuildInProgressError,
  TemplateBuildNotFoundError,
  TemplateExistsError,
  TemplateNotFoundError,
  UnauthorizedError,
  VolumeInUseError,
  VolumeLimitExceededError,
  VolumeNotFoundError,
  VolumeSyncPendingError,
} from "../src/errors.js";
import {
  CapacityUnavailableError as PublicCapacityUnavailableError,
  DataPlaneNotReadyError as PublicDataPlaneNotReadyError,
  RegistryImageNotFoundError as PublicRegistryImageNotFoundError,
  ResumeFailedError as PublicResumeFailedError,
  SnapshotNotDurableError as PublicSnapshotNotDurableError,
  StorageConnectionDisabledError as PublicStorageConnectionDisabledError,
  StorageConnectionNotFoundError as PublicStorageConnectionNotFoundError,
  StorageMountAttachCancelledError as PublicStorageMountAttachCancelledError,
  StorageMountNotFoundError as PublicStorageMountNotFoundError,
} from "../src/index.js";

describe("mapError", () => {
  it("preserves the TemplateBuildFailedError ErrorOptions constructor", () => {
    const cause = new Error("remote failure");
    expect(new TemplateBuildFailedError("build failed", { cause }).cause).toBe(cause);
  });

  it("exports SnapshotNotDurableError from the package entrypoint", () => {
    expect(PublicSnapshotNotDurableError).toBe(SnapshotNotDurableError);
  });

  it("exports ResumeFailedError from the package entrypoint", () => {
    expect(PublicResumeFailedError).toBe(ResumeFailedError);
  });

  it("exports CapacityUnavailableError from the package entrypoint", () => {
    expect(PublicCapacityUnavailableError).toBe(CapacityUnavailableError);
  });

  it("exports DataPlaneNotReadyError from the package entrypoint", () => {
    expect(PublicDataPlaneNotReadyError).toBe(DataPlaneNotReadyError);
  });

  it("exports RegistryImageNotFoundError from the package entrypoint", () => {
    expect(PublicRegistryImageNotFoundError).toBe(RegistryImageNotFoundError);
  });

  it("passes through SandboxError instances", () => {
    const err = new SessionNotFoundError("already mapped");
    expect(mapError(err)).toBe(err);
  });

  it("wraps plain Error as SandboxError", () => {
    const err = new Error("boom");
    const mapped = mapError(err);
    expect(mapped).toBeInstanceOf(SandboxError);
    expect(mapped.message).toContain("boom");
    expect(mapped.cause).toBeInstanceOf(ConnectError);
  });

  it("wraps non-Error values", () => {
    const mapped = mapError("string error");
    expect(mapped).toBeInstanceOf(SandboxError);
    expect(mapped.message).toContain("string error");
  });

  describe("ConnectError mapping", () => {
    function connectErr(code: Code, message: string): ConnectError {
      return new ConnectError(message, code);
    }

    it("maps Unauthenticated to UnauthorizedError", () => {
      expect(mapError(connectErr(Code.Unauthenticated, "bad token"))).toBeInstanceOf(UnauthorizedError);
    });

    it("maps PermissionDenied", () => {
      expect(mapError(connectErr(Code.PermissionDenied, "nope"))).toBeInstanceOf(PermissionDeniedError);
    });

    it("maps Aborted resume failure to ResumeFailedError", () => {
      expect(mapError(connectErr(Code.Aborted, "resume failed, session is PAUSED: restore timed out"))).toBeInstanceOf(
        ResumeFailedError,
      );
    });

    it("keeps other Aborted errors generic", () => {
      const mapped = mapError(connectErr(Code.Aborted, "volume attachment changed during detach"));
      expect(mapped).not.toBeInstanceOf(ResumeFailedError);
      expect(mapped).toBeInstanceOf(SandboxError);
    });

    it("maps NotFound to SessionNotFoundError by default", () => {
      expect(mapError(connectErr(Code.NotFound, "session not found"))).toBeInstanceOf(SessionNotFoundError);
    });

    it("maps a missing storage connection or mount to its own error, not SessionNotFoundError", () => {
      const connection = mapError(connectErr(Code.NotFound, "storage connection not found"));
      expect(connection).toBeInstanceOf(StorageConnectionNotFoundError);
      expect(connection).not.toBeInstanceOf(SessionNotFoundError);
      expect(mapError(connectErr(Code.NotFound, "storage mount not found"))).toBeInstanceOf(StorageMountNotFoundError);
      expect(PublicStorageConnectionNotFoundError).toBe(StorageConnectionNotFoundError);
      expect(PublicStorageMountNotFoundError).toBe(StorageMountNotFoundError);
    });

    it("maps an attach that the caller's own detach cancelled to StorageMountAttachCancelledError", () => {
      const cancelled = mapError(connectErr(Code.Aborted, "storage mount attach was cancelled by a detach"));
      expect(cancelled).toBeInstanceOf(StorageMountAttachCancelledError);
      expect(cancelled).not.toBeInstanceOf(InvalidStateError);
      expect(PublicStorageMountAttachCancelledError).toBe(StorageMountAttachCancelledError);
      expect(mapError(connectErr(Code.Aborted, "read ECONNRESET"))).not.toBeInstanceOf(
        StorageMountAttachCancelledError,
      );
    });

    it("maps a connection Tenki disabled to StorageConnectionDisabledError", () => {
      const disabled = mapError(
        connectErr(Code.FailedPrecondition, 'storage connection "Build cache" was disabled by Tenki; contact support'),
      );
      expect(disabled).toBeInstanceOf(StorageConnectionDisabledError);
      expect(disabled).not.toBeInstanceOf(InvalidStateError);
      expect(PublicStorageConnectionDisabledError).toBe(StorageConnectionDisabledError);
    });

    it("maps NotFound with 'template build' to TemplateBuildNotFoundError", () => {
      expect(mapError(connectErr(Code.NotFound, "template build xyz not found"))).toBeInstanceOf(
        TemplateBuildNotFoundError,
      );
    });

    it("maps NotFound with 'template' to TemplateNotFoundError", () => {
      expect(mapError(connectErr(Code.NotFound, "template not found"))).toBeInstanceOf(TemplateNotFoundError);
    });

    it("maps NotFound with 'registry image' to RegistryImageNotFoundError", () => {
      expect(mapError(connectErr(Code.NotFound, "registry image version not found"))).toBeInstanceOf(
        RegistryImageNotFoundError,
      );
    });

    it("maps NotFound with 'snapshot' to SnapshotNotFoundError", () => {
      expect(mapError(connectErr(Code.NotFound, "snapshot not found"))).toBeInstanceOf(SnapshotNotFoundError);
    });

    it("maps NotFound with 'volume' to VolumeNotFoundError", () => {
      expect(mapError(connectErr(Code.NotFound, "volume not found"))).toBeInstanceOf(VolumeNotFoundError);
    });

    it("maps NotFound with 'artifact' to SessionExpiredError", () => {
      expect(mapError(connectErr(Code.NotFound, "artifact not found"))).toBeInstanceOf(SessionExpiredError);
    });

    it("maps AlreadyExists with 'template' to TemplateExistsError", () => {
      expect(mapError(connectErr(Code.AlreadyExists, "template already exists"))).toBeInstanceOf(TemplateExistsError);
    });

    it("maps DeadlineExceeded to CommandTimeoutError", () => {
      expect(mapError(connectErr(Code.DeadlineExceeded, "timed out"))).toBeInstanceOf(CommandTimeoutError);
    });

    it("maps edge 404 Unimplemented to DataPlaneNotReadyError", () => {
      const mapped = mapError(connectErr(Code.Unimplemented, "HTTP status 404 Not Found"));
      expect(mapped).toBeInstanceOf(DataPlaneNotReadyError);
      expect((mapped as DataPlaneNotReadyError).retryable).toBe(true);
    });

    it("maps ResourceExhausted with 'maximum exposed ports'", () => {
      expect(mapError(connectErr(Code.ResourceExhausted, "maximum exposed ports reached"))).toBeInstanceOf(
        PortLimitExceededError,
      );
    });

    it("maps ResourceExhausted with 'volume'", () => {
      expect(mapError(connectErr(Code.ResourceExhausted, "volume limit reached"))).toBeInstanceOf(
        VolumeLimitExceededError,
      );
    });

    it("maps ResourceExhausted with 'rate limit'", () => {
      expect(mapError(connectErr(Code.ResourceExhausted, "rate limit exceeded"))).toBeInstanceOf(RateLimitedError);
    });

    it("maps ResourceExhausted with 'capacity'", () => {
      expect(mapError(connectErr(Code.ResourceExhausted, "sandbox capacity unavailable"))).toBeInstanceOf(
        CapacityUnavailableError,
      );
    });

    it("maps ResourceExhausted default to QuotaExceededError", () => {
      expect(mapError(connectErr(Code.ResourceExhausted, "out of resources"))).toBeInstanceOf(QuotaExceededError);
    });

    it("maps FailedPrecondition with 'terminated'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "session terminated"))).toBeInstanceOf(
        SessionTerminatedError,
      );
    });

    it("maps FailedPrecondition with 'build in progress'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "template build already in progress"))).toBeInstanceOf(
        TemplateBuildInProgressError,
      );
    });

    it("maps FailedPrecondition with 'sync_pending'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "sync_pending"))).toBeInstanceOf(VolumeSyncPendingError);
    });

    it("maps FailedPrecondition with 'volume is attached'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "volume is attached"))).toBeInstanceOf(VolumeInUseError);
    });

    it("maps FailedPrecondition with 'inbound access is disabled'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "inbound access is disabled"))).toBeInstanceOf(
        InboundDisabledError,
      );
    });

    it("maps FailedPrecondition with 'ssh'", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "ssh unavailable"))).toBeInstanceOf(SSHUnavailableError);
    });

    it("maps FailedPrecondition with snapshot not durable", () => {
      expect(
        mapError(connectErr(Code.FailedPrecondition, "snapshot not yet durable on a reachable host")),
      ).toBeInstanceOf(SnapshotNotDurableError);
    });

    it("maps FailedPrecondition default to InvalidStateError", () => {
      expect(mapError(connectErr(Code.FailedPrecondition, "some other precondition"))).toBeInstanceOf(
        InvalidStateError,
      );
    });

    it("maps unconfigured session metrics to InvalidStateError", () => {
      expect(
        mapError(connectErr(Code.FailedPrecondition, "sandbox session metrics are not configured")),
      ).toBeInstanceOf(InvalidStateError);
    });

    it("maps a transient git failure to a retryable GitOperationFailedError", () => {
      const mapped = mapError(
        connectErr(
          Code.FailedPrecondition,
          "git clone failed (exit_code=128); check the repository, ref and access token: fatal: unable to access 'https://github.com/x/y': Recv failure: Connection reset by peer",
        ),
      );
      expect(mapped).toBeInstanceOf(GitOperationFailedError);
      expect((mapped as GitOperationFailedError).retryable).toBe(true);
      expect((mapped as GitOperationFailedError).exitCode).toBe(128);
      // stderr is just the git output, not the engine wrapper prefix.
      expect((mapped as GitOperationFailedError).stderr).toBe(
        "fatal: unable to access 'https://github.com/x/y': Recv failure: Connection reset by peer",
      );
      // No longer the un-actionable InvalidStateError it used to fall through to.
      expect(mapped).not.toBeInstanceOf(InvalidStateError);
    });

    it("maps an auth git failure to a non-retryable GitOperationFailedError", () => {
      const mapped = mapError(
        connectErr(
          Code.FailedPrecondition,
          "git fetch PR failed (exit_code=128); check the repository, ref and access token: fatal: Authentication failed for 'https://github.com/x/y'",
        ),
      );
      expect(mapped).toBeInstanceOf(GitOperationFailedError);
      expect((mapped as GitOperationFailedError).retryable).toBe(false);
      expect((mapped as GitOperationFailedError).stderr).toBe(
        "fatal: Authentication failed for 'https://github.com/x/y'",
      );
    });

    it("maps a repo-not-found git failure to a non-retryable GitOperationFailedError", () => {
      const mapped = mapError(
        connectErr(
          Code.FailedPrecondition,
          "git clone failed (exit_code=128); check the repository, ref and access token: fatal: repository 'https://github.com/x/y' not found",
        ),
      );
      expect(mapped).toBeInstanceOf(GitOperationFailedError);
      expect((mapped as GitOperationFailedError).retryable).toBe(false);
      expect((mapped as GitOperationFailedError).stderr).toBe("fatal: repository 'https://github.com/x/y' not found");
    });

    it("does not treat a terminal fetch-pack data-corruption error as retryable", () => {
      const mapped = mapError(
        connectErr(
          Code.FailedPrecondition,
          "git fetch PR failed (exit_code=128); check the repository, ref and access token: fatal: fetch-pack: invalid index-pack output",
        ),
      );
      expect(mapped).toBeInstanceOf(GitOperationFailedError);
      expect((mapped as GitOperationFailedError).retryable).toBe(false);
      expect((mapped as GitOperationFailedError).stderr).toBe("fatal: fetch-pack: invalid index-pack output");
    });

    it("treats a git failure with neither transient nor terminal markers as non-retryable", () => {
      const mapped = mapError(
        connectErr(
          Code.FailedPrecondition,
          "git clone failed (exit_code=128); check the repository, ref and access token: something unexpected",
        ),
      );
      expect(mapped).toBeInstanceOf(GitOperationFailedError);
      expect((mapped as GitOperationFailedError).retryable).toBe(false);
      expect((mapped as GitOperationFailedError).stderr).toBe("something unexpected");
    });

    it("maps Unavailable with 'ssh'", () => {
      expect(mapError(connectErr(Code.Unavailable, "ssh not ready"))).toBeInstanceOf(SSHUnavailableError);
    });

    it("maps unknown code to SandboxError", () => {
      expect(mapError(connectErr(Code.Internal, "internal error"))).toBeInstanceOf(SandboxError);
    });
  });
});

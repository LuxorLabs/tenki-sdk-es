import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import {
  CapabilityUnavailableError,
  DataPlaneNotReadyError,
  PrimitiveTimeoutError,
  SessionTerminatedError,
  sessionTerminationCause,
} from "../src/errors.js";
import {
  RunResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { run } from "../src/process.js";
import { Session } from "../src/session.js";

function sessionWithRunReason(reason: string): Session {
  const dataPlaneClient = {
    run: vi.fn(() =>
      (async function* () {
        yield {
          frame: create(RunResponseSchema, {
            payload: {
              case: "exit",
              value: { exitCode: -1, signal: "", timedOut: false, durationMs: 0n, reason, errno: 0 },
            },
          }),
        };
      })(),
    ),
  };
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 5);
  (session as any).dataPlaneClient = dataPlaneClient;
  return session;
}

function sessionWithTransientRunError(err: unknown): Session {
  let calls = 0;
  const dataPlaneClient = {
    run: vi.fn(() =>
      (async function* () {
        calls++;
        if (calls === 1) throw err;
        yield {
          frame: create(RunResponseSchema, {
            payload: { case: "started", value: { pid: 1n } },
          }),
        };
      })(),
    ),
  };
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 100);
  (session as any).dataPlaneClient = dataPlaneClient;
  return session;
}

function sessionWithTransientRunReset(err: unknown): { session: Session; run: ReturnType<typeof vi.fn> } {
  let calls = 0;
  const runMock = vi.fn(() =>
    (async function* () {
      calls++;
      if (calls === 1) throw err;
      yield {
        frame: create(RunResponseSchema, {
          payload: { case: "started", value: { pid: 1n } },
        }),
      };
      yield {
        frame: create(RunResponseSchema, {
          payload: {
            case: "exit",
            value: { exitCode: 0, signal: "", timedOut: false, durationMs: 1n, reason: "exit", errno: 0 },
          },
        }),
      };
    })(),
  );
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 100);
  (session as any).dataPlaneClient = { run: runMock };
  return { session, run: runMock };
}

function sessionWithResetAfterStarted(err: unknown): { session: Session; run: ReturnType<typeof vi.fn> } {
  const runMock = vi.fn(() =>
    (async function* () {
      yield {
        frame: create(RunResponseSchema, {
          payload: { case: "started", value: { pid: 1n } },
        }),
      };
      throw err;
    })(),
  );
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 100);
  (session as any).dataPlaneClient = { run: runMock };
  return { session, run: runMock };
}

function sessionWithDeferredRunReset(err: unknown): {
  session: Session;
  run: ReturnType<typeof vi.fn>;
  release: () => void;
} {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runMock = vi.fn(() =>
    (async function* () {
      await ready;
      throw err;
    })(),
  );
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 100);
  (session as any).dataPlaneClient = { run: runMock };
  return { session, run: runMock, release };
}

function sessionWithRunError(err: unknown): Session {
  const dataPlaneClient = {
    run: vi.fn(() =>
      (async function* () {
        throw err;
      })(),
    ),
  };
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 5);
  (session as any).dataPlaneClient = dataPlaneClient;
  return session;
}

describe("run() exit-reason routing", () => {
  it("first_frame_timeout reason throws PrimitiveTimeoutError", async () => {
    const proc = run(sessionWithRunReason("first_frame_timeout: no response from guest-agent within deadline"), [
      "echo",
    ]);
    await expect(proc).rejects.toBeInstanceOf(PrimitiveTimeoutError);
  });

  it("capability_unavailable reason throws CapabilityUnavailableError", async () => {
    const proc = run(sessionWithRunReason("capability_unavailable: run unsupported"), ["echo"]);
    await expect(proc).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("first_frame_timeout is also a CapabilityUnavailableError for grouped establishment failures", async () => {
    const proc = run(sessionWithRunReason("first_frame_timeout: deadline"), ["echo"]);
    await expect(proc).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("capability_unavailable is not a PrimitiveTimeoutError", async () => {
    const proc = run(sessionWithRunReason("capability_unavailable: run unsupported"), ["echo"]);
    await expect(proc).rejects.not.toBeInstanceOf(PrimitiveTimeoutError);
  });

  it("session_terminated reason throws a retryable SessionTerminatedError carrying the cause", async () => {
    const proc = run(sessionWithRunReason("session_terminated:guest_agent_liveness: silent for 2m0s"), ["echo"]);
    await expect(proc).rejects.toBeInstanceOf(SessionTerminatedError);
    await expect(proc).rejects.toMatchObject({
      terminationCause: "guest_agent_liveness",
      retryable: true,
    });
  });

  it("session_terminated is neither a capability nor a timeout failure", async () => {
    const proc = run(sessionWithRunReason("session_terminated:guest_agent_liveness"), ["echo"]);
    await expect(proc).rejects.not.toBeInstanceOf(CapabilityUnavailableError);
    await expect(proc).rejects.not.toBeInstanceOf(PrimitiveTimeoutError);
  });

  it("parses the termination cause out of the exit reason", () => {
    expect(sessionTerminationCause("session_terminated:guest_agent_liveness: detail")).toBe("guest_agent_liveness");
    expect(sessionTerminationCause("session_terminated:guest_shutdown")).toBe("guest_shutdown");
    expect(sessionTerminationCause("session_terminated")).toBe("");
    expect(sessionTerminationCause("capability_unavailable: foo")).toBe("");
  });

  it("edge 404 unimplemented is a retryable data-plane readiness error", async () => {
    const proc = run(sessionWithRunError(new ConnectError("HTTP status 404 Not Found", Code.Unimplemented)), ["echo"]);
    await expect(proc).rejects.toMatchObject({
      name: "DataPlaneNotReadyError",
      retryable: true,
    });
    await expect(proc).rejects.toBeInstanceOf(DataPlaneNotReadyError);
    await expect(proc).rejects.not.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("retries edge 404 while opening run stream", async () => {
    const proc = run(sessionWithTransientRunError(new ConnectError("HTTP status 404 Not Found", Code.Unimplemented)), [
      "echo",
    ]);
    await expect(proc.pid).resolves.toBe(1);
  });

  it("retries an ECONNRESET before the first run response", async () => {
    const { session, run: runMock } = sessionWithTransientRunReset(new ConnectError("read ECONNRESET", Code.Aborted));
    const proc = run(session, ["echo"]);
    await proc.stdin.close();

    await expect(proc).resolves.toMatchObject({ exitCode: 0 });
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("does not replay an ECONNRESET after the run has started", async () => {
    const { session, run: runMock } = sessionWithResetAfterStarted(new ConnectError("read ECONNRESET", Code.Aborted));
    const proc = run(session, ["echo"]);
    await proc.stdin.close();

    await expect(proc.pid).resolves.toBe(1);
    await expect(proc).rejects.toThrow("ECONNRESET");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay an ECONNRESET after interactive stdin is written", async () => {
    const {
      session,
      run: runMock,
      release,
    } = sessionWithDeferredRunReset(new ConnectError("read ECONNRESET", Code.Aborted));
    const proc = run(session, ["cat"]);
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode("side effect\n"));
    release();

    await expect(proc).rejects.toThrow("ECONNRESET");
    expect(runMock).toHaveBeenCalledTimes(1);
    writer.releaseLock();
  });
});

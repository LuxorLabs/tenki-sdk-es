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

/**
 * A guest that starts the process, optionally emits output, and then never
 * sends an exit frame - the shape produced by a backgrounded grandchild holding
 * stdout/stderr open. The SDK does not bound this; the guest-agent's own
 * execution budget is what ends such a run.
 */
function sessionWithHangingRun(stdout?: string): {
  session: Session;
  sent: Array<{ payload: { case?: string; value?: unknown } }>;
} {
  const sent: Array<{ payload: { case?: string; value?: unknown } }> = [];
  const runMock = vi.fn((requests: AsyncIterable<{ frame?: unknown }>) => {
    void (async () => {
      for await (const req of requests) {
        if (req.frame) sent.push(req.frame as never);
      }
    })();
    return (async function* () {
      yield {
        frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }),
      };
      if (stdout !== undefined) {
        yield {
          frame: create(RunResponseSchema, {
            payload: { case: "stdout", value: new TextEncoder().encode(stdout) },
          }),
        };
      }
      await new Promise(() => {});
    })();
  });
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", "tenki_session", undefined, 5);
  (session as any).dataPlaneClient = { run: runMock };
  return { session, sent };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A guest that starts the process, optionally emits output, and then reports the
 * given exit frame. This is how a spent execution budget actually reaches the
 * SDK: the guest kills the process and sends an ordinary exit.
 */
function sessionWithRunExit(
  exit: { exitCode?: number; signal?: string; timedOut?: boolean; reason?: string },
  stdout?: string,
): { session: Session; sent: Array<{ payload: { case?: string; value?: unknown } }> } {
  const sent: Array<{ payload: { case?: string; value?: unknown } }> = [];
  const runMock = vi.fn((requests: AsyncIterable<{ frame?: unknown }>) => {
    void (async () => {
      for await (const req of requests) {
        if (req.frame) sent.push(req.frame as never);
      }
    })();
    return (async function* () {
      yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
      if (stdout !== undefined) {
        yield {
          frame: create(RunResponseSchema, {
            payload: { case: "stdout", value: new TextEncoder().encode(stdout) },
          }),
        };
      }
      yield {
        frame: create(RunResponseSchema, {
          payload: {
            case: "exit",
            value: {
              exitCode: exit.exitCode ?? 0,
              signal: exit.signal ?? "",
              timedOut: exit.timedOut ?? false,
              durationMs: 12n,
              reason: exit.reason ?? "exit",
              errno: 0,
            },
          },
        }),
      };
    })();
  });
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", "tenki_session", undefined, 5);
  (session as any).dataPlaneClient = { run: runMock };
  return { session, sent };
}

describe("run() timeout budget", () => {
  it("advertises the budget to the guest on the start frame", async () => {
    const { session, sent } = sessionWithRunExit({});
    await run(session, ["sleep", "600"], { timeoutMs: 40 });
    await flush();

    const start = sent.find((frame) => frame.payload.case === "start");
    expect(start?.payload.value).toMatchObject({ timeoutMs: 40 });
  });

  it("sends 0 when no budget is given, which the guest reads as unbounded", async () => {
    const { session, sent } = sessionWithRunExit({});
    await run(session, ["sleep", "600"]);
    await flush();

    const start = sent.find((frame) => frame.payload.case === "start");
    expect(start?.payload.value).toMatchObject({ timeoutMs: 0 });
  });

  it("rounds a sub-millisecond budget up so it never becomes unbounded", async () => {
    const { session, sent } = sessionWithRunExit({});
    await run(session, ["sleep", "600"], { timeoutMs: 0.4 });
    await flush();

    const start = sent.find((frame) => frame.payload.case === "start");
    expect(start?.payload.value).toMatchObject({ timeoutMs: 1 });
  });

  it("surfaces a guest timeout as timedOut rather than rejecting", async () => {
    // A timed-out run arrives as exitCode 0, so callers must check timedOut.
    const { session } = sessionWithRunExit({ exitCode: 0, timedOut: true, reason: "timeout" });

    await expect(run(session, ["sleep", "600"], { timeoutMs: 40 })).resolves.toMatchObject({
      exitCode: 0,
      timedOut: true,
      reason: "timeout",
    });
  });

  it("keeps the output captured before the budget expired", async () => {
    const { session } = sessionWithRunExit({ exitCode: 0, timedOut: true, reason: "timeout" }, "listening on :3000\n");

    const result = await run(session, ["start-server"], { timeoutMs: 40 });
    expect(new TextDecoder().decode(result.stdout)).toBe("listening on :3000\n");
  });

  it("does not bound the run itself when the guest stays quiet", async () => {
    // The SDK deliberately does not compensate for a guest that ignores the budget.
    const { session } = sessionWithHangingRun();
    const proc = run(session, ["sleep", "600"], { timeoutMs: 40 });

    const settled = await Promise.race([
      proc.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 120)),
    ]);
    expect(settled).toBe("pending");
  });
});

describe("run() abandonment", () => {
  it("does not re-send the start request when abandoned during establishment backoff", async () => {
    // resetOutbound re-queues RunStart; retrying would run the command twice.
    let starts = 0;
    const runMock = vi.fn((requests: AsyncIterable<{ frame?: { payload: { case?: string } } }>) => {
      void (async () => {
        for await (const req of requests) {
          if (req.frame?.payload.case === "start") starts++;
        }
      })();
      return (async function* (): AsyncGenerator<never> {
        throw new ConnectError("HTTP status 404 Not Found", Code.Unimplemented);
      })();
    });
    const proto = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
    });
    const session = new Session(
      {} as never,
      proto,
      "tk_test",
      "wss://gateway.tenki.test",
      "tenki_session",
      undefined,
      10_000,
    );
    (session as any).dataPlaneClient = { run: runMock };

    const controller = new AbortController();
    const proc = run(session, ["rm", "-rf", "important"], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("caller gave up"));
    await expect(proc).rejects.toThrow("caller gave up");
    const callsAtAbort = runMock.mock.calls.length;

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(runMock.mock.calls.length).toBe(callsAtAbort);
    expect(starts).toBeLessThanOrEqual(callsAtAbort);
  });
});

describe("run() abort signal", () => {
  it("aborts an in-flight run with the caller's reason", async () => {
    const { session, sent } = sessionWithHangingRun();
    const controller = new AbortController();
    const proc = run(session, ["sleep", "600"], { signal: controller.signal });
    await proc.pid;

    const reason = new Error("caller gave up");
    controller.abort(reason);

    await expect(proc).rejects.toBe(reason);
    await flush();
    expect(sent.filter((frame) => frame.payload.case === "signal")).toHaveLength(1);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { session } = sessionWithHangingRun();
    const controller = new AbortController();
    controller.abort(new Error("too late"));
    const proc = run(session, ["sleep", "600"], { signal: controller.signal });

    await expect(proc).rejects.toThrow("too late");
  });

  it("replays a pre-start signal onto the reconnected stream", async () => {
    const perAttempt: Array<Array<string | undefined>> = [];
    let attempt = 0;
    const runMock = vi.fn((requests: AsyncIterable<{ frame?: { payload: { case?: string } } }>) => {
      const seen: Array<string | undefined> = [];
      perAttempt.push(seen);
      const mine = ++attempt;
      void (async () => {
        for await (const req of requests) {
          if (req.frame) seen.push(req.frame.payload.case);
        }
      })();
      return (async function* () {
        if (mine === 1) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new ConnectError("read ECONNRESET", Code.Aborted);
        }
        yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 9n } } }) };
        await new Promise(() => {});
      })();
    });
    const proto = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
    });
    const session = new Session(
      {} as never,
      proto,
      "tk_test",
      "wss://gateway.tenki.test",
      "tenki_session",
      undefined,
      10_000,
    );
    (session as any).dataPlaneClient = { run: runMock };

    const proc = run(session, ["sleep", "600"]);
    await proc.signal("KILL");
    await expect(proc.pid).resolves.toBe(9);
    await flush();

    expect(perAttempt.length).toBeGreaterThanOrEqual(2);
    expect(perAttempt[1]).toContain("signal");
  });
});

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

  it("retries not-found while an unverified data plane is still provisioning", async () => {
    const proc = run(sessionWithTransientRunError(new ConnectError("session not found", Code.NotFound)), ["echo"]);
    await expect(proc.pid).resolves.toBe(1);
  });

  it("retries unavailable while an unverified data plane is still provisioning", async () => {
    const proc = run(
      sessionWithTransientRunError(new ConnectError("HTTP status 503 Service Unavailable", Code.Unavailable)),
      ["echo"],
    );
    await expect(proc.pid).resolves.toBe(1);
  });

  it("does not retry not-found after the data plane is verified", async () => {
    const session = sessionWithRunError(new ConnectError("session not found", Code.NotFound));
    (session as any).dataPlaneVerifiedClient = (session as any).dataPlaneClient;
    const proc = run(session, ["echo"]);

    await expect(proc).rejects.toMatchObject({ name: "SessionNotFoundError" });
    expect((session as any).dataPlaneClient.run).toHaveBeenCalledOnce();
  });

  it("does not retry generic unavailable after the data plane is verified", async () => {
    const session = sessionWithRunError(new ConnectError("HTTP status 503 Service Unavailable", Code.Unavailable));
    (session as any).dataPlaneVerifiedClient = (session as any).dataPlaneClient;
    const proc = run(session, ["echo"]);

    await expect(proc).rejects.toMatchObject({ name: "SandboxError" });
    expect((session as any).dataPlaneClient.run).toHaveBeenCalledOnce();
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

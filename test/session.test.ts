import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataPlaneNotReadyError, FileNotFoundError } from "../src/errors.js";
import {
  CreateSessionCredentialResponseSchema,
  DataPlaneRouteStatus,
  GetSessionResponseSchema,
  PauseSessionResponseSchema,
  ResumeSessionResponseSchema,
  RunResponseSchema,
  RunSignal_Sig,
  SandboxSessionSchema,
  SessionCredentialSchema,
  SessionState,
  WaitSessionResponseSchema,
  type RunStart,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

describe("Session streaming", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams output incrementally from data-plane Run", async () => {
    const dataPlane = makeDataPlaneRunClient();
    const session = makeSession(makeRpcClient(), dataPlane);
    const stream = await session.stream("whoami");

    const first = await stream.next();
    expect(first && Array.from(first.data)).toEqual([97]);
    expect(first?.isStderr).toBe(false);

    const second = await stream.next();
    expect(second && Array.from(second.data)).toEqual([98]);
    expect(second?.isStderr).toBe(true);

    await expect(stream.next()).resolves.toBeNull();
    const result = await stream.wait();
    expect(result.status).toBe("SUCCEEDED");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(12);
    expect(dataPlane.run).toHaveBeenCalledTimes(1);
  });

  it("exec aggregates data-plane Run output and keeps onOutput behavior", async () => {
    const onOutput = vi.fn();
    const dataPlane = makeDataPlaneRunClient();
    const result = await makeSession(makeRpcClient(), dataPlane).exec("whoami", { onOutput });

    expect(Array.from(result.stdout)).toEqual([97]);
    expect(Array.from(result.stderr)).toEqual([98]);
    expect(result.outputs).toHaveLength(2);
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(dataPlane.run).toHaveBeenCalledTimes(1);
  });

  it("exec passes relative cwd to data-plane Run", async () => {
    const dataPlane = makeDataPlaneRunClient();
    await makeSession(makeRpcClient(), dataPlane).exec("pwd", { cwd: "project" });

    expect(dataPlane.starts[0]?.cwd).toBe("project");
  });

  it("stream passes absolute cwd to data-plane Run", async () => {
    const dataPlane = makeDataPlaneRunClient();
    const stream = await makeSession(makeRpcClient(), dataPlane).stream("pwd", { cwd: "/home/tenki/project" });
    await stream.wait();

    expect(dataPlane.starts[0]?.cwd).toBe("/home/tenki/project");
  });

  it("exec maps missing cwd failures after passing cwd unchanged", async () => {
    const dataPlane = makeDataPlaneRunClient({
      runErrorByCwd: {
        missing: new ConnectError("cwd /home/tenki/missing: no such file or directory", Code.NotFound),
      },
    });

    await expect(makeSession(makeRpcClient(), dataPlane).exec("pwd", { cwd: "missing" })).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
    expect(dataPlane.starts[0]?.cwd).toBe("missing");
  });

  it("exec surfaces traversal-like cwd failures after passing cwd unchanged", async () => {
    const dataPlane = makeDataPlaneRunClient({
      runErrorByCwd: {
        "../outside": new ConnectError("cwd ../outside: invalid argument", Code.InvalidArgument),
      },
    });

    await expect(makeSession(makeRpcClient(), dataPlane).exec("pwd", { cwd: "../outside" })).rejects.toEqual(
      expect.objectContaining({
        name: "SandboxError",
        message: expect.stringContaining("invalid argument"),
      }),
    );
    expect(dataPlane.starts[0]?.cwd).toBe("../outside");
  });

  it("exec closes stdin for commands without stdin input", async () => {
    const dataPlane = makeDataPlaneRunClient({ requireStdinClose: true });
    const result = await makeSession(makeRpcClient(), dataPlane).exec("cat");

    expect(result.exitCode).toBe(0);
    expect(dataPlane.followups).toEqual(["stdinClose"]);
  });

  it("stream rejects onOutput", async () => {
    const session = makeSession(makeRpcClient(), makeDataPlaneRunClient());
    await expect(session.stream("whoami", { onOutput: vi.fn() })).rejects.toThrow("does not support onOutput");
  });

  it("stream closes stdin because the stream wrapper only exposes output", async () => {
    const dataPlane = makeDataPlaneRunClient({ requireStdinClose: true });
    const stream = await makeSession(makeRpcClient(), dataPlane).stream("cat");

    await expect(stream.wait()).resolves.toMatchObject({ exitCode: 0 });
    expect(dataPlane.followups).toEqual(["stdinClose"]);
  });

  it("run keeps request stream open for signal after stdin close", async () => {
    const dataPlane = makeDataPlaneRunClient({ requireSignalAfterStdinClose: true });
    const proc = makeSession(makeRpcClient(), dataPlane).run(["cat"]);

    await expect(proc.pid).resolves.toBe(42);
    await proc.stdin.close();
    await dataPlane.readyForSignal;
    await proc.signal("TERM");

    await expect(proc).resolves.toMatchObject({ exitCode: 0 });
    expect(dataPlane.requestClosedBeforeSignal).toBe(false);
    expect(dataPlane.followups).toEqual(["stdinClose", "signal"]);
    expect(dataPlane.signals).toEqual([RunSignal_Sig.TERM]);
  });

  it("probes data-plane readiness inside the guest workdir", async () => {
    const dataPlane = makeDataPlaneRunClient();
    const session = makeSession(makeRpcClient(), dataPlane);

    await session.ensureDataPlane();

    expect(dataPlane.stat).toHaveBeenCalledTimes(1);
    expect(dataPlane.stat.mock.calls[0]?.[0].request?.path).toBe("/home/tenki");
  });

  it("retries credential while route_status is NOT_READY", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.createSessionCredential = vi
      .fn()
      .mockResolvedValueOnce(makeCredentialResponse(DataPlaneRouteStatus.NOT_READY))
      .mockResolvedValueOnce(makeCredentialResponse(DataPlaneRouteStatus.VERIFIED, ""));
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).dataPlaneClient = undefined;

    await expect(session.ensureDataPlane()).resolves.toBeUndefined();
    expect(rpcClient.createSessionCredential).toHaveBeenCalledTimes(2);
  });

  it("surfaces terminal route_status FAILED", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.createSessionCredential = vi.fn().mockResolvedValue(makeCredentialResponse(DataPlaneRouteStatus.FAILED));
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).dataPlaneClient = undefined;

    await expect(session.ensureDataPlane()).rejects.toMatchObject({
      name: "DataPlaneNotReadyError",
      terminal: true,
      retryable: false,
    });
    await expect(session.ensureDataPlane()).rejects.toBeInstanceOf(DataPlaneNotReadyError);
  });

  it("waitReady uses WaitSession stream instead of GetSession polling", async () => {
    const rpcClient = makeRpcClient();
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).state = "CREATING";

    await session.waitReady(1_000);

    expect(session.state).toBe("RUNNING");
    expect(rpcClient.waitSession).toHaveBeenCalledTimes(1);
    expect(rpcClient.getSession).not.toHaveBeenCalled();
    expect((session as any).dataPlaneEndpoint).toBe("http://data-plane.test");
    expect((session as any).dataPlaneCredential.current()).toBe("wait-session-credential");
    expect((session as any).dataPlaneVerifiedClient).toBe((session as any).dataPlaneClient);
  });

  it("waitReady includes terminalError", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.waitSession = vi.fn(() =>
      (async function* () {
        yield create(WaitSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.TERMINATED,
            ownerType: "SERVICE",
            ownerId: "self",
            terminalError: "sandbox provisioned but readiness check failed",
          }),
        });
      })(),
    );
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).state = "CREATING";

    await expect(session.waitReady(1_000)).rejects.toThrow(
      "session entered terminal state: TERMINATED: sandbox provisioned but readiness check failed",
    );
  });

  it("waitReady falls back to GetSession polling when WaitSession is unimplemented", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.waitSession = vi.fn(() => {
      throw new ConnectError("unimplemented", Code.Unimplemented);
    });
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).state = "CREATING";

    await session.waitReady(1_000);

    expect(session.state).toBe("RUNNING");
    expect(rpcClient.getSession).toHaveBeenCalledTimes(1);
  });

  it("waitReady falls back to polling when the stream connection resets", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.waitSession = vi.fn(() => {
      throw new ConnectError("read ECONNRESET", Code.Aborted);
    });
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).state = "CREATING";

    await session.waitReady(1_000);

    expect(session.state).toBe("RUNNING");
    expect(rpcClient.waitSession).toHaveBeenCalledTimes(1);
    expect(rpcClient.getSession).toHaveBeenCalledTimes(1);
  });

  it("waitReady does not hide non-transient stream failures", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.waitSession = vi.fn(() => {
      throw new ConnectError("permission denied", Code.PermissionDenied);
    });
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    (session as any).state = "CREATING";

    await expect(session.waitReady(1_000)).rejects.toMatchObject({ cause: { code: Code.PermissionDenied } });
    expect(rpcClient.getSession).not.toHaveBeenCalled();
  });

  it("pause and resume refresh local state", async () => {
    const rpcClient = makeRpcClient();
    const session = makeSession(rpcClient, makeDataPlaneRunClient());
    const pausedCredential = { stop: vi.fn() };
    (session as any).dataPlaneEndpoint = "http://old-data-plane.test";
    (session as any).dataPlaneCredential = pausedCredential;
    (session as any).dataPlaneVerifiedClient = (session as any).dataPlaneClient;

    await session.pause();
    expect(session.state).toBe("PAUSED");
    expect(pausedCredential.stop).toHaveBeenCalledTimes(1);
    expect((session as any).dataPlaneEndpoint).toBe("");
    expect((session as any).dataPlaneCredential).toBeUndefined();
    expect((session as any).dataPlaneClient).toBeUndefined();
    expect((session as any).dataPlaneVerifiedClient).toBeUndefined();

    const resumedCredential = { stop: vi.fn() };
    (session as any).dataPlaneEndpoint = "http://old-data-plane.test";
    (session as any).dataPlaneCredential = resumedCredential;
    (session as any).dataPlaneClient = makeDataPlaneRunClient();
    (session as any).dataPlaneVerifiedClient = (session as any).dataPlaneClient;

    await session.resume();
    expect(session.state).toBe("RUNNING");
    expect(resumedCredential.stop).toHaveBeenCalledTimes(1);
    expect((session as any).dataPlaneEndpoint).toBe("");
    expect((session as any).dataPlaneCredential).toBeUndefined();
    expect((session as any).dataPlaneClient).toBeUndefined();
    expect((session as any).dataPlaneVerifiedClient).toBeUndefined();
  });

  it("maps pauseExpiresAt for paused sessions and leaves it unset otherwise", () => {
    const expiry = new Date("2026-07-11T12:00:00Z");
    const paused = new Session(
      makeRpcClient() as never,
      create(SandboxSessionSchema, {
        id: "session-1",
        state: SessionState.PAUSED,
        ownerType: "SERVICE",
        ownerId: "self",
        pauseExpiresAt: timestampFromDate(expiry),
      }),
      "tk_test",
      "wss://gateway.tenki.test",
    );
    expect(paused.pauseExpiresAt).toEqual(expiry);

    const running = new Session(makeRpcClient() as never, makeSessionProto(), "tk_test", "wss://gateway.tenki.test");
    expect(running.pauseExpiresAt).toBeUndefined();
  });
});

function makeSession(
  rpcClient: ReturnType<typeof makeRpcClient>,
  dataPlane: ReturnType<typeof makeDataPlaneRunClient>,
): Session {
  const session = new Session(rpcClient as never, makeSessionProto(), "tk_test", "wss://gateway.tenki.test");
  (session as any).dataPlaneClient = dataPlane;
  return session;
}

function makeSessionProto() {
  return create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
}

function makeDataPlaneRunClient(options?: {
  requireStdinClose?: boolean;
  requireSignalAfterStdinClose?: boolean;
  runErrorByCwd?: Record<string, ConnectError>;
}) {
  const followups: string[] = [];
  const signals: RunSignal_Sig[] = [];
  const starts: RunStart[] = [];
  let requestClosedBeforeSignal = false;
  let resolveReadyForSignal: () => void = () => {};
  const readyForSignal = new Promise<void>((resolve) => {
    resolveReadyForSignal = resolve;
  });
  return {
    followups,
    signals,
    starts,
    readyForSignal,
    get requestClosedBeforeSignal() {
      return requestClosedBeforeSignal;
    },
    stat: vi.fn(async () => ({ response: { exists: true, isDir: true } })),
    run: vi.fn((req: AsyncIterable<any>) =>
      (async function* () {
        const iter = req[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.value.frame.payload.case).toBe("start");
        starts.push(first.value.frame.payload.value);
        const runError = options?.runErrorByCwd?.[first.value.frame.payload.value.cwd];
        if (runError) throw runError;
        yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
        if (options?.requireStdinClose || options?.requireSignalAfterStdinClose) {
          const next = await iter.next();
          followups.push(next.value.frame.payload.case);
        }
        if (options?.requireSignalAfterStdinClose) {
          const pendingSignal = iter.next();
          const signalReadiness = await Promise.race([
            pendingSignal.then((next) => ({ kind: "next" as const, next })),
            new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 0)),
          ]);
          if (signalReadiness.kind === "next") {
            requestClosedBeforeSignal = signalReadiness.next.done === true;
            if (!signalReadiness.next.done) {
              followups.push(signalReadiness.next.value.frame.payload.case);
              signals.push(signalReadiness.next.value.frame.payload.value.signal);
            }
            resolveReadyForSignal();
          } else {
            resolveReadyForSignal();
            const signalReq = await pendingSignal;
            requestClosedBeforeSignal = signalReq.done === true;
            if (!signalReq.done) {
              followups.push(signalReq.value.frame.payload.case);
              signals.push(signalReq.value.frame.payload.value.signal);
            }
          }
        }
        yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array([97]) } }) };
        yield { frame: create(RunResponseSchema, { payload: { case: "stderr", value: new Uint8Array([98]) } }) };
        yield {
          frame: create(RunResponseSchema, {
            payload: {
              case: "exit",
              value: { exitCode: 0, signal: "", timedOut: false, durationMs: 12n, reason: "exit", errno: 0 },
            },
          }),
        };
      })(),
    ),
  };
}

function makeCredentialResponse(routeStatus: DataPlaneRouteStatus, dataPlaneEndpoint = "http://data-plane.test") {
  return create(CreateSessionCredentialResponseSchema, {
    credential: create(SessionCredentialSchema, { credential: "ready" }),
    dataPlaneEndpoint,
    routeStatus,
  });
}

function makeRpcClient() {
  return {
    getSession: vi.fn(async () =>
      create(GetSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    ),
    waitSession: vi.fn(() =>
      (async function* () {
        yield create(WaitSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.CREATING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        });
        yield create(WaitSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.RUNNING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
          dataPlaneEndpoint: "http://data-plane.test",
          credential: create(SessionCredentialSchema, { credential: "wait-session-credential" }),
          routeStatus: DataPlaneRouteStatus.VERIFIED,
        });
      })(),
    ),
    pauseSession: vi.fn(async () =>
      create(PauseSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.PAUSED,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    ),
    resumeSession: vi.fn(async () =>
      create(ResumeSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    ),
    createSessionCredential: vi.fn(async () => makeCredentialResponse(DataPlaneRouteStatus.UNSPECIFIED)),
  };
}

describe("Session waitResumed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function getSessionSequence(states: SessionState[], lastResumeError?: string) {
    let call = 0;
    return vi.fn(async () => {
      const state = states[Math.min(call++, states.length - 1)]!;
      const stopped = state === SessionState.PAUSED || state === SessionState.USER_SHUTDOWN;
      return create(GetSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state,
          ownerType: "SERVICE",
          ownerId: "self",
          lastResumeError: stopped ? (lastResumeError ?? "") : "",
        }),
      });
    });
  }

  it("resolves once the session reaches RUNNING", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.getSession = getSessionSequence([SessionState.RESUMING, SessionState.RUNNING]);
    const session = makeSession(rpcClient, makeDataPlaneRunClient());

    await session.waitResumed(10_000);
    expect(session.state).toBe("RUNNING");
  });

  it("throws ResumeFailedError with lastResumeError when the session reverts to PAUSED", async () => {
    const restoreErr =
      "snapshot restore failed: reidentify guest network failed after 3 attempts: " +
      "sh: 57: cannot create /etc/netplan/50-cloud-init.yaml: Structure needs cleaning";
    const rpcClient = makeRpcClient();
    rpcClient.getSession = getSessionSequence([SessionState.RESUMING, SessionState.PAUSED], restoreErr);
    const session = makeSession(rpcClient, makeDataPlaneRunClient());

    await expect(session.waitResumed(10_000)).rejects.toEqual(
      expect.objectContaining({
        name: "ResumeFailedError",
        message: expect.stringContaining(restoreErr),
      }),
    );
  });

  it("keeps polling through a stale PAUSED read before RESUMING is observed", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.getSession = getSessionSequence(
      [SessionState.PAUSED, SessionState.RESUMING, SessionState.RUNNING],
      "error from a previous, unrelated resume attempt",
    );
    const session = makeSession(rpcClient, makeDataPlaneRunClient());

    await session.waitResumed(10_000);
    expect(session.state).toBe("RUNNING");
  });

  it("surfaces terminal states", async () => {
    const rpcClient = makeRpcClient();
    rpcClient.getSession = getSessionSequence([SessionState.TERMINATED]);
    const session = makeSession(rpcClient, makeDataPlaneRunClient());

    await expect(session.waitResumed(10_000)).rejects.toThrow(/terminal state/);
  });
});

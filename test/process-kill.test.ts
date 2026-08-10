import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import {
  RunResponseSchema,
  RunSignal_Sig,
  SandboxSessionSchema,
  SessionState,
  type RunRequest,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { run } from "../src/process.js";
import { Session } from "../src/session.js";

function makeSession(dataPlaneClient: unknown): Session {
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  // 5th arg is cookieName and 6th is sshOptions; the ready budget is 7th.
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", "tenki_session", undefined, 5);
  (session as any).dataPlaneClient = dataPlaneClient;
  return session;
}

/**
 * Guest whose process outlives the signal frame: the exit frame is withheld
 * until `release()` is called. Holding those two events apart is what lets a
 * test tell "signal sent" from "process dead".
 */
function gatedKillSession(): {
  session: Session;
  signals: RunSignal_Sig[];
  signalSeen: Promise<void>;
  release: () => void;
} {
  const signals: RunSignal_Sig[] = [];
  let markSignalSeen = () => {};
  const signalSeen = new Promise<void>((resolve) => {
    markSignalSeen = resolve;
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const dataPlaneClient = {
    run: vi.fn((requests: AsyncIterable<{ frame?: RunRequest }>) =>
      (async function* () {
        const it = requests[Symbol.asyncIterator]();
        await it.next(); // start frame
        yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 4242n } } }) };
        for (;;) {
          const { done, value } = await it.next();
          if (done) break;
          const payload = value?.frame?.payload;
          if (payload?.case === "signal") {
            signals.push(payload.value.signal);
            markSignalSeen();
            break;
          }
        }
        await released;
        yield {
          frame: create(RunResponseSchema, {
            payload: {
              case: "exit",
              // Mirror the real guest: a signal-killed process reports exitCode
              // -1 (not the shell's 128+9) and Go's own name "killed".
              value: { exitCode: -1, signal: "killed", timedOut: false, durationMs: 0n, reason: "signaled", errno: 0 },
            },
          }),
        };
      })(),
    ),
  };

  return { session: makeSession(dataPlaneClient), signals, signalSeen, release };
}

function immediateExitSession(): Session {
  return makeSession({
    run: vi.fn(() =>
      (async function* () {
        yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 4243n } } }) };
        yield {
          frame: create(RunResponseSchema, {
            payload: {
              case: "exit",
              value: { exitCode: 0, signal: "", timedOut: false, durationMs: 1n, reason: "exit", errno: 0 },
            },
          }),
        };
      })(),
    ),
  });
}

describe("process termination", () => {
  it("sends SIGKILL and resolves before the process has exited", async () => {
    const { session, signals, signalSeen, release } = gatedKillSession();
    const proc = run(session, ["sleep", "3600"]);
    expect(await proc.pid).toBe(4242);

    await proc.kill();
    await signalSeen;
    expect(signals).toEqual([RunSignal_Sig.KILL]);

    // kill() has already resolved while the exit frame is still gated, so the
    // handle itself must not have settled yet.
    const state = await Promise.race([
      Promise.resolve(proc).then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(state).toBe("pending");

    release();
    const result = await proc;
    expect(result.exitCode).toBe(-1);
    expect(result.signal).toBe("killed");
  });

  it("routes kill() to SIGKILL and signal() to the named signal", async () => {
    const { session, signals, signalSeen, release } = gatedKillSession();
    const proc = run(session, ["sleep", "3600"]);
    await proc.pid;

    await proc.signal("SIGTERM");
    await signalSeen;
    expect(signals).toEqual([RunSignal_Sig.TERM]);

    release();
    await proc;
  });

  // The Go SDK returns a stream error here instead; both are "best effort", and
  // each SDK's README documents its own behaviour.
  it("treats killing an already-exited process as a no-op", async () => {
    const proc = run(immediateExitSession(), ["true"]);
    const result = await proc;
    expect(result.exitCode).toBe(0);

    await expect(proc.kill()).resolves.toBeUndefined();
  });
});

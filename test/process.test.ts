import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { CapabilityUnavailableError, DataPlaneNotReadyError, PrimitiveTimeoutError } from "../src/errors.js";
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
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", "tenki_session", undefined, 5);
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
  const session = new Session(
    {} as never,
    proto,
    "tk_test",
    "wss://gateway.tenki.test",
    "tenki_session",
    undefined,
    100,
  );
  (session as any).dataPlaneClient = dataPlaneClient;
  return session;
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
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", "tenki_session", undefined, 5);
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
});

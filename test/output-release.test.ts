import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import {
  RunResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

function makeSession(rpc = {}): Session {
  return new Session(
    rpc as never,
    create(SandboxSessionSchema, { id: "test-session", state: SessionState.RUNNING }),
    "tk_test",
    "wss://gateway.test",
  );
}

async function read(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader();
  const bytes: number[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return bytes;
    bytes.push(...chunk.value);
  }
}

describe("stream output retention", () => {
  it.each([false, true])("delivers chunks with streamOnly=%s", async (streamOnly) => {
    const session = makeSession();
    (session as any).dataPlaneClient = {
      run: () =>
        (async function* () {
          yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
          yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array([1, 2]) } }) };
          yield { frame: create(RunResponseSchema, { payload: { case: "stderr", value: new Uint8Array([3, 4]) } }) };
          yield {
            frame: create(RunResponseSchema, {
              payload: { case: "exit", value: { exitCode: 7, durationMs: 12n, reason: "exit" } },
            }),
          };
        })(),
    };
    const handle = session.run(["test"], { streamOnly });
    const [stdout, stderr, result] = await Promise.all([
      read(handle.stdout),
      read(handle.stderr),
      Promise.resolve(handle),
    ]);
    expect(stdout).toEqual([1, 2]);
    expect(stderr).toEqual([3, 4]);
    expect(Array.from(result.stdout)).toEqual(streamOnly ? [] : stdout);
    expect(Array.from(result.stderr)).toEqual(streamOnly ? [] : stderr);
    expect(result.exitCode).toBe(7);
    expect(result.durationMs).toBe(12);
  });
});

describe("stream-only backpressure", () => {
  it("bounds unread output while preserving delivery", async () => {
    const session = makeSession();
    let produced = 0;
    (session as any).dataPlaneClient = {
      run: () =>
        (async function* () {
          yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
          for (let index = 0; index < 32; index++) {
            produced++;
            yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array(32768) } }) };
          }
          yield { frame: create(RunResponseSchema, { payload: { case: "exit", value: { exitCode: 0 } } }) };
        })(),
    };
    const handle = session.run(["test"], { streamOnly: true });
    await vi.waitFor(() => expect(produced).toBe(2));
    const [stdout, stderr, result] = await Promise.all([
      read(handle.stdout),
      read(handle.stderr),
      Promise.resolve(handle),
    ]);
    expect(stdout).toHaveLength(32 * 32768);
    expect(stderr).toEqual([]);
    expect(result.stdout).toHaveLength(0);
  });

  it("allows a cancelled output reader to stop consuming without retaining bytes", async () => {
    const session = makeSession();
    (session as any).dataPlaneClient = {
      run: () =>
        (async function* () {
          yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
          for (let index = 0; index < 32; index++) {
            yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array(32768) } }) };
          }
          yield { frame: create(RunResponseSchema, { payload: { case: "exit", value: { exitCode: 0 } } }) };
        })(),
    };
    const handle = session.run(["test"], { streamOnly: true });
    await handle.stdout.cancel();
    const result = await handle;
    expect(result.stdout).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});

describe("stream-only teardown", () => {
  it("unblocks a paused output producer on abort", async () => {
    const session = makeSession();
    const abort = new AbortController();
    let produced = 0;
    let finished = false;
    (session as any).dataPlaneClient = {
      run: () =>
        (async function* () {
          try {
            yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
            for (let index = 0; index < 32; index++) {
              produced++;
              yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array(32768) } }) };
            }
            yield { frame: create(RunResponseSchema, { payload: { case: "exit", value: { exitCode: 0 } } }) };
          } finally {
            finished = true;
          }
        })(),
    };
    const handle = session.run(["test"], { streamOnly: true, signal: abort.signal });
    await vi.waitFor(() => expect(produced).toBe(2));
    const result = Promise.resolve(handle);
    const reason = new Error("reader abandoned");
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
    await vi.waitFor(() => expect(finished).toBe(true));
  });

  it("propagates an iterator error after the paused reader is cancelled", async () => {
    const session = makeSession();
    let produced = 0;
    (session as any).dataPlaneClient = {
      run: () =>
        (async function* () {
          yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 42n } } }) };
          for (let index = 0; index < 2; index++) {
            produced++;
            yield { frame: create(RunResponseSchema, { payload: { case: "stdout", value: new Uint8Array(32768) } }) };
          }
          throw new Error("transport failed");
        })(),
    };
    const handle = session.run(["test"], { streamOnly: true });
    await vi.waitFor(() => expect(produced).toBe(2));
    const result = Promise.resolve(handle);
    await handle.stdout.cancel();
    await expect(result).rejects.toThrow("transport failed");
  });
});

describe("session release", () => {
  it("stops renewal and frees the connection without terminating", async () => {
    const terminateSession = vi.fn(async () => ({}));
    const createSessionCredential = vi.fn();
    const session = makeSession({ terminateSession, createSessionCredential });
    const stop = vi.fn();
    (session as any).dataPlaneCredential = { stop };
    session.release();
    session.release();
    expect(stop).toHaveBeenCalledTimes(1);
    await session[Symbol.asyncDispose]();
    expect(terminateSession).not.toHaveBeenCalled();
    expect((session as any).dataPlaneCredential).toBeUndefined();
    await expect(session.requireDataPlane()).rejects.toThrow("released");
    expect(createSessionCredential).not.toHaveBeenCalled();
    await session.close();
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a credential response that arrives after release", async () => {
    let respond!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      respond = resolve;
    });
    const createSessionCredential = vi.fn(() => response);
    const session = makeSession({ createSessionCredential });
    const renewal = session.renewDataPlaneCredential();
    session.release();
    respond({ dataPlaneEndpoint: "https://node.test", credential: { credential: "late" } });
    expect(await renewal).toBe(false);
    expect((session as any).dataPlaneCredential).toBeUndefined();
    expect((session as any).dataPlaneClient).toBeUndefined();
    await expect(session.requireDataPlane()).rejects.toThrow("released");
  });

  it("does not reopen a released handle when termination fails", async () => {
    const session = makeSession({
      terminateSession: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    });
    session.release();
    await expect(session.close()).rejects.toThrow();
    await expect(session.requireDataPlane()).rejects.toThrow("released");
  });
});

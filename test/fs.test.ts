import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileNotFoundError, IncompleteWriteError, mapError, mapWriteError, StreamClosedError } from "../src/errors.js";
import { stat, writeFileStream } from "../src/fs.js";
import type { WriteFileStreamRequest } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

describe("writeFileStream abort handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops draining the source once the RPC rejects early", async () => {
    let read = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        read++;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const dataPlane = {
      writeFileStream: vi.fn(() => Promise.reject(new Error("server aborted"))),
    };

    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).rejects.toThrow();
    expect(read).toBeLessThan(50); // bounded: did not drain the (effectively unbounded) source into memory
  });

  it("rejects as soon as the RPC fails while the source is stalled", async () => {
    let sourceCanceled = false;
    const source = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        sourceCanceled = true;
      },
    });
    const dataPlane = {
      writeFileStream: vi.fn(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("server aborted")), 20)),
      ),
    };

    const started = Date.now();
    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sourceCanceled).toBe(true);
  });

  it("fails instead of truncating when the server ends the stream early with success", async () => {
    let read = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        read++;
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const dataPlane = {
      writeFileStream: vi.fn(() => Promise.resolve({})),
    };

    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).rejects.toThrow(StreamClosedError);
    expect(read).toBeLessThan(50);
  });

  it("fails as soon as the server ends the stream early while the source is stalled", async () => {
    let sourceCanceled = false;
    const source = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        sourceCanceled = true;
      },
    });
    const dataPlane = {
      writeFileStream: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({}), 20))),
    };

    const started = Date.now();
    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).rejects.toThrow(StreamClosedError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sourceCanceled).toBe(true);
  });

  it("succeeds for an empty source the server fully consumes", async () => {
    let frames = 0;
    const dataPlane = {
      writeFileStream: vi.fn(async (iterable: AsyncIterable<unknown>) => {
        for await (const _ of iterable) {
          void _;
          frames++;
        }
        return {};
      }),
    };
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).resolves.toBeUndefined();
    expect(frames).toBe(1);
  });

  it("succeeds for a multi-chunk source the server consumes and settles right away", async () => {
    let frames = 0;
    const received: number[] = [];
    const dataPlane = {
      writeFileStream: vi.fn(async (iterable: AsyncIterable<{ frame?: WriteFileStreamRequest }>) => {
        for await (const req of iterable) {
          frames++;
          if (req.frame?.payload.case === "data") received.push(...req.frame.payload.value);
        }
        return { response: { bytesWritten: BigInt(received.length) } };
      }),
    };
    const chunks = [1, 2, 3].map((n) => new Uint8Array([n]));
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });

    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).resolves.toBeUndefined();
    expect(frames).toBe(4);
    expect(received).toEqual([1, 2, 3]);
  });

  it("surfaces a mid-stream source error to the RPC consumer instead of a clean close", async () => {
    let consumerError: unknown;
    const dataPlane = {
      writeFileStream: vi.fn(async (iterable: AsyncIterable<unknown>) => {
        try {
          for await (const _ of iterable) {
            void _;
          }
        } catch (err) {
          consumerError = err;
          throw err;
        }
      }),
    };
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("source blew up");
      },
    });

    await expect(writeFileStream(makeSession(dataPlane), "/w/f", source)).rejects.toThrow();
    expect(consumerError).toBeInstanceOf(Error);
    expect((consumerError as Error).message).toBe("source blew up");
  });
});

describe("write byte accounting", () => {
  const chunks = [new TextEncoder().encode("hello "), new TextEncoder().encode("world")];

  function skewedDataPlane(delta: bigint) {
    return {
      writeFileStream: vi.fn(
        async (frames: AsyncIterable<{ frame?: { payload: { case?: string; value?: unknown } } }>) => {
          let received = 0n;
          for await (const { frame } of frames) {
            if (frame?.payload.case === "data") received += BigInt((frame.payload.value as Uint8Array).byteLength);
          }
          return { response: { bytesWritten: received + delta, path: "/w/f" } };
        },
      ),
      writeFile: vi.fn(async (req: { request?: { content: Uint8Array } }) => ({
        response: { sizeBytes: BigInt(req.request?.content.byteLength ?? 0) + delta, path: "/w/f" },
      })),
    };
  }

  function source(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it.each([0n, -1n, 1n, -11n])("rejects stream and unary writes when the sandbox saves %s bytes off", async (delta) => {
    const session = makeSession(skewedDataPlane(delta));
    const writes = [
      () => writeFileStream(session, "/w/f", source()),
      () => Session.prototype.writeFile.call(session, "/w/f", "hello world"),
    ];
    for (const write of writes) {
      if (delta === 0n) {
        await expect(write()).resolves.toBeUndefined();
      } else {
        await expect(write()).rejects.toThrow(IncompleteWriteError);
        await expect(write()).rejects.toThrow("sent 11 bytes");
      }
    }
  });

  it("maps data_loss to IncompleteWriteError only for writes", () => {
    const dataLoss = new ConnectError("incomplete write: sandbox wrote 2 of 4 bytes", Code.DataLoss);
    expect(mapWriteError(dataLoss)).toBeInstanceOf(IncompleteWriteError);
    expect(mapError(dataLoss)).not.toBeInstanceOf(IncompleteWriteError);
  });
});

function makeSession(dataPlane: unknown): Session {
  return {
    id: "session-1",
    requireDataPlane: async () => dataPlane,
  } as unknown as Session;
}

describe("stat", () => {
  it("throws FileNotFoundError when the path does not exist", async () => {
    const dataPlane = {
      stat: async () => ({
        response: {
          exists: false,
          size: 0n,
          mode: 0,
          isDir: false,
          modifiedUnixNs: 0n,
          isSymlink: false,
          symlinkTarget: "",
        },
      }),
    };
    await expect(stat(makeSession(dataPlane), "/home/tenki/missing")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("returns FileInfo when the path exists", async () => {
    const dataPlane = {
      stat: async () => ({
        response: {
          exists: true,
          size: 5n,
          mode: 0o644,
          isDir: false,
          modifiedUnixNs: 42n,
          isSymlink: false,
          symlinkTarget: "",
        },
      }),
    };
    const info = await stat(makeSession(dataPlane), "/home/tenki/a.txt");
    expect(info.size).toBe(5n);
    expect(info.isDir).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileNotFoundError } from "../src/errors.js";
import { stat, writeFileStream } from "../src/fs.js";
import type { Session } from "../src/session.js";

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

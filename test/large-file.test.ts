import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { DATA_PLANE_SESSION_OPTIONS } from "../src/http2-drain.js";
import type { WriteFileStreamRequest } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

const UNARY_CAP = 32 * 1024 * 1024;

function tooLarge(operation: "ReadFile" | "WriteFile", size: number): ConnectError {
  return new ConnectError(
    `file too large for ${operation}: size_bytes=${size} max_bytes=${UNARY_CAP}; use ${operation}Stream`,
    Code.ResourceExhausted,
  );
}

function fakeSession(dataPlane: unknown): Session {
  return { id: "session-1", requireDataPlane: async () => dataPlane } as unknown as Session;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function patterned(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return data;
}

describe("files above the unary cap", () => {
  it("writes over WriteFileStream in frames of at most 1 MiB", async () => {
    const content = patterned(UNARY_CAP + 3 * 1024 * 1024);
    const frames: Uint8Array[] = [];
    const dataPlane = {
      writeFile: vi.fn(),
      stat: vi.fn(async () => ({ response: { exists: false } })),
      writeFileStream: vi.fn(async (requests: AsyncIterable<{ frame?: WriteFileStreamRequest }>) => {
        let bytes = 0n;
        for await (const request of requests) {
          if (request.frame?.payload.case === "data") {
            frames.push(request.frame.payload.value);
            bytes += BigInt(request.frame.payload.value.byteLength);
          }
        }
        return { response: { bytesWritten: bytes } };
      }),
    };

    await Session.prototype.writeFile.call(fakeSession(dataPlane), "/home/tenki/big", content);

    expect(dataPlane.writeFile).not.toHaveBeenCalled();
    expect(Math.max(...frames.map((f) => f.byteLength))).toBe(1024 * 1024);
    const received = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
    let offset = 0;
    for (const f of frames) {
      received.set(f, offset);
      offset += f.byteLength;
    }
    expect(sameBytes(received, content)).toBe(true);
  });

  it.each([
    { name: "a new file", stat: { exists: false }, want: 0o644 },
    { name: "an existing 0600 file", stat: { exists: true, mode: 0o600 }, want: 0o600 },
    // Go's os.ModeSetuid bit as the guest reports it.
    { name: "an existing setuid file", stat: { exists: true, mode: (1 << 23) | 0o750 }, want: 0o750 },
  ])("keeps the permission bits of $name on a large write", async ({ stat, want }) => {
    let startMode: number | undefined;
    const dataPlane = {
      stat: vi.fn(async () => ({ response: { mode: 0, isDir: false, ...stat } })),
      writeFileStream: vi.fn(async (requests: AsyncIterable<{ frame?: WriteFileStreamRequest }>) => {
        let bytes = 0n;
        for await (const request of requests) {
          if (request.frame?.payload.case === "start") startMode = request.frame.payload.value.mode;
          if (request.frame?.payload.case === "data") bytes += BigInt(request.frame.payload.value.byteLength);
        }
        return { response: { bytesWritten: bytes } };
      }),
    };

    await Session.prototype.writeFile.call(fakeSession(dataPlane), "/home/tenki/big", new Uint8Array(UNARY_CAP + 1));

    expect(startMode).toBe(want);
  });

  it("reads over ReadFileStream when the unary read is refused as too large", async () => {
    const content = patterned(UNARY_CAP + 3 * 1024 * 1024);
    const dataPlane = {
      readFile: vi.fn(async () => {
        throw tooLarge("ReadFile", content.byteLength);
      }),
      readFileStream: vi.fn(async function* () {
        for (let offset = 0; offset < content.byteLength; offset += 1024 * 1024) {
          yield { response: { data: content.subarray(offset, offset + 1024 * 1024), eof: false } };
        }
        yield { response: { data: new Uint8Array(), eof: true } };
      }),
    };

    const got = await Session.prototype.readFile.call(fakeSession(dataPlane), "/home/tenki/big");

    expect(dataPlane.readFileStream).toHaveBeenCalledTimes(1);
    expect(sameBytes(got, content)).toBe(true);
  });

  it("keeps files within the cap on the unary RPCs", async () => {
    const content = patterned(UNARY_CAP);
    const dataPlane = {
      writeFile: vi.fn(async () => ({ response: { sizeBytes: BigInt(content.byteLength) } })),
      readFile: vi.fn(async () => ({ response: { content } })),
      writeFileStream: vi.fn(),
      readFileStream: vi.fn(),
    };
    const session = fakeSession(dataPlane);

    await Session.prototype.writeFile.call(session, "/home/tenki/cap", content);
    expect(sameBytes(await Session.prototype.readFile.call(session, "/home/tenki/cap"), content)).toBe(true);
    expect(dataPlane.writeFileStream).not.toHaveBeenCalled();
    expect(dataPlane.readFileStream).not.toHaveBeenCalled();
  });

  it("does not fall back to the stream for other read errors", async () => {
    const dataPlane = {
      readFile: vi.fn(async () => {
        throw new ConnectError("no such file", Code.NotFound);
      }),
      readFileStream: vi.fn(),
    };

    await expect(Session.prototype.readFile.call(fakeSession(dataPlane), "/home/tenki/missing")).rejects.toThrow();
    expect(dataPlane.readFileStream).not.toHaveBeenCalled();
  });
});

describe("data-plane HTTP/2 session options", () => {
  it("raises the per-stream receive window above Node's 64 KiB default", () => {
    expect(DATA_PLANE_SESSION_OPTIONS).toMatchObject({ settings: { initialWindowSize: 16 * 1024 * 1024 } });
  });
});

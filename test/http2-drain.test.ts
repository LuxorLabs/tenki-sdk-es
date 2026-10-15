import type http2 from "node:http2";
import { PassThrough } from "node:stream";
import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deferDestroyUntilDrained, DrainingHttp2SessionManager } from "../src/http2-drain.js";

// A PassThrough stands in for a ClientHttp2Stream: same Duplex semantics, plus rstCode.
function fakeStream(rstCode?: number): http2.ClientHttp2Stream & PassThrough {
  const stream = new PassThrough() as PassThrough & { rstCode?: number };
  stream.rstCode = rstCode;
  return stream as unknown as http2.ClientHttp2Stream & PassThrough;
}

// Mirrors Bun's streamEnd: buffer the coalesced frames, push EOF, then destroy at once.
function endWithBufferedData(stream: http2.ClientHttp2Stream & PassThrough, ...chunks: string[]): void {
  for (const chunk of chunks) stream.push(Buffer.from(chunk));
  stream.push(null);
  stream.destroy();
}

describe("deferDestroyUntilDrained", () => {
  it("delivers buffered data before a clean close destroys the stream", async () => {
    const stream = fakeStream(0);
    deferDestroyUntilDrained(stream);
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));

    endWithBufferedData(stream, "stdout", "exit");
    expect(stream.destroyed).toBe(false);

    let received = "";
    for await (const chunk of stream) received += String(chunk);
    expect(received).toBe("stdoutexit");

    await closed;
    expect(stream.destroyed).toBe(true);
  });

  it("treats an unset rstCode as a clean close", () => {
    const stream = fakeStream(undefined);
    deferDestroyUntilDrained(stream);
    endWithBufferedData(stream, "data");
    expect(stream.destroyed).toBe(false);
  });

  it("destroys immediately when the stream was reset with an error code", () => {
    const stream = fakeStream(2);
    deferDestroyUntilDrained(stream);
    endWithBufferedData(stream, "data");
    expect(stream.destroyed).toBe(true);
  });

  it("destroys immediately when destroy carries an error", () => {
    const stream = fakeStream(0);
    deferDestroyUntilDrained(stream);
    stream.on("error", () => {});
    stream.push(Buffer.from("data"));
    stream.destroy(new Error("boom"));
    expect(stream.destroyed).toBe(true);
  });

  it("destroys immediately when nothing is buffered", () => {
    const stream = fakeStream(0);
    deferDestroyUntilDrained(stream);
    stream.push(null);
    stream.destroy();
    expect(stream.destroyed).toBe(true);
  });
});

describe("DrainingHttp2SessionManager", () => {
  afterEach(() => vi.restoreAllMocks());

  it("enlarges each connection once, including replacement connections", async () => {
    const first = { state: { effectiveLocalWindowSize: 65535 }, on: vi.fn(), setLocalWindowSize: vi.fn() };
    const replacement = {
      state: { effectiveLocalWindowSize: 32 * 1024 * 1024 },
      on: vi.fn(),
      setLocalWindowSize: vi.fn(),
    };
    const streams = [first, first, replacement].map((session) => Object.assign(fakeStream(0), { session }));
    const request = vi.spyOn(Http2SessionManager.prototype, "request");
    for (const stream of streams) request.mockResolvedValueOnce(stream);
    const manager = new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, false);
    for (let i = 0; i < streams.length; i++) await manager.request("POST", "/rpc", {}, {});
    expect(first.setLocalWindowSize).toHaveBeenCalledExactlyOnceWith(16 * 1024 * 1024);
    expect(replacement.setLocalWindowSize).toHaveBeenCalledExactlyOnceWith(32 * 1024 * 1024);
  });

  it("skips the window when disabled and survives a failing setLocalWindowSize", async () => {
    const skipped = { state: { effectiveLocalWindowSize: 65535 }, on: vi.fn(), setLocalWindowSize: vi.fn() };
    const failing = {
      state: { effectiveLocalWindowSize: 65535 },
      on: vi.fn(),
      setLocalWindowSize: vi.fn(() => {
        throw new Error("not supported");
      }),
    };
    const request = vi.spyOn(Http2SessionManager.prototype, "request");
    request.mockResolvedValueOnce(Object.assign(fakeStream(0), { session: skipped }));
    request.mockResolvedValueOnce(Object.assign(fakeStream(0), { session: failing }));
    await new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, false, false).request(
      "POST",
      "/rpc",
      {},
      {},
    );
    await expect(
      new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, false).request(
        "POST",
        "/rpc",
        {},
        {},
      ),
    ).resolves.toBeDefined();
    expect(skipped.setLocalWindowSize).not.toHaveBeenCalled();
    expect(failing.setLocalWindowSize).toHaveBeenCalledOnce();
  });

  it("guards each session against late connection errors", async () => {
    const { EventEmitter } = await import("node:events");
    const session = Object.assign(new EventEmitter(), {
      state: { effectiveLocalWindowSize: 65535 },
      setLocalWindowSize: vi.fn(),
    });
    vi.spyOn(Http2SessionManager.prototype, "request").mockResolvedValue(Object.assign(fakeStream(0), { session }));
    await new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, false).request(
      "POST",
      "/rpc",
      {},
      {},
    );
    expect(() => session.emit("error", new Error("PING timed out"))).not.toThrow();
  });

  it("patches destroy on every stream it opens when draining is enabled", async () => {
    const stream = fakeStream(0);
    vi.spyOn(Http2SessionManager.prototype, "request").mockResolvedValue(stream);
    const manager = new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, true);

    const opened = await manager.request("POST", "/rpc", {}, {});
    expect(opened).toBe(stream);
    expect(Object.hasOwn(stream, "destroy")).toBe(true);
  });

  it("leaves streams untouched when draining is disabled", async () => {
    const stream = fakeStream(0);
    vi.spyOn(Http2SessionManager.prototype, "request").mockResolvedValue(stream);
    const manager = new DrainingHttp2SessionManager("https://sandbox.example.com", undefined, undefined, false);

    await manager.request("POST", "/rpc", {}, {});
    expect(Object.hasOwn(stream, "destroy")).toBe(false);
  });
});

it("delivers all bytes on 100 concurrent HTTP/2 streams", async () => {
  const { createServer } = await import("node:http2");
  const server = createServer({ maxSessionMemory: 64 });
  const connections = new Set<http2.ServerHttp2Session>();
  const clients = new Set<http2.Http2Session>();
  const payload = Buffer.alloc(256 * 1024, 42);
  server.on("session", (session) => connections.add(session));
  server.on("stream", (stream) => {
    stream.respond({ ":status": 200 });
    stream.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const manager = new DrainingHttp2SessionManager(`http://127.0.0.1:${address.port}`, undefined, undefined, false);
  try {
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        const stream = await manager.request("POST", "/stream", {}, {});
        if (stream.session) clients.add(stream.session);
        stream.end();
        const chunks = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      }),
    );
    expect(connections.size).toBe(1);
  } finally {
    for (const connection of clients) connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15_000);

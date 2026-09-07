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

import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRefusedStreamOrGoAway,
  isRetryableStreamTransportError,
  REFUSED_STREAM_MAX_RETRIES,
  refusedStreamRetry,
} from "../src/refused-stream.js";

// Unit coverage for the REFUSED_STREAM/GOAWAY transparent retry interceptor.
function refusedErr(): Error {
  return new Error("[internal] Stream closed with error code NGHTTP2_REFUSED_STREAM");
}

function unaryReq() {
  return { stream: false, signal: new AbortController().signal } as never;
}

function streamReq() {
  return { stream: true, signal: new AbortController().signal } as never;
}

describe("isRefusedStreamOrGoAway", () => {
  it("detects REFUSED_STREAM in the message", () => {
    expect(isRefusedStreamOrGoAway(refusedErr())).toBe(true);
  });

  it("detects GOAWAY in the message", () => {
    expect(isRefusedStreamOrGoAway(new Error("HTTP/2 GOAWAY received"))).toBe(true);
  });

  it("detects the node http2 code on the cause chain", () => {
    const cause = Object.assign(new Error("session closed"), { code: "ERR_HTTP2_GOAWAY_SESSION" });
    const err = new Error("rpc failed", { cause });
    expect(isRefusedStreamOrGoAway(err)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isRefusedStreamOrGoAway(new Error("permission denied"))).toBe(false);
    expect(isRefusedStreamOrGoAway(undefined)).toBe(false);
  });

  // RFC 7540 §8.1.1: CANCEL/INTERNAL_ERROR resets do not prove the request went
  // unprocessed, so they must NOT be retried — even though connect-node tags them
  // with the same generic code (ERR_HTTP2_STREAM_ERROR) as a REFUSED_STREAM.
  it("does not match other RST_STREAM reasons (CANCEL / INTERNAL_ERROR)", () => {
    for (const reason of ["NGHTTP2_CANCEL", "NGHTTP2_INTERNAL_ERROR", "NGHTTP2_PROTOCOL_ERROR"]) {
      const cause = Object.assign(new Error(`Stream closed with error code ${reason}`), {
        code: "ERR_HTTP2_STREAM_ERROR",
      });
      expect(isRefusedStreamOrGoAway(new Error("[internal] rpc failed", { cause }))).toBe(false);
    }
  });
});

describe("isRetryableStreamTransportError", () => {
  it("accepts reset and unavailable establishment failures", () => {
    expect(isRetryableStreamTransportError(new ConnectError("read ECONNRESET", Code.Aborted))).toBe(true);
    expect(isRetryableStreamTransportError(new ConnectError("unexpected EOF", Code.Unavailable))).toBe(true);
  });

  it("rejects non-transient RPC failures", () => {
    expect(isRetryableStreamTransportError(new ConnectError("permission denied", Code.PermissionDenied))).toBe(false);
  });
});

describe("refusedStreamRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("transparently succeeds after N-1 REFUSED_STREAM failures", async () => {
    vi.useFakeTimers();
    const next = vi
      .fn()
      .mockRejectedValueOnce(refusedErr())
      .mockRejectedValueOnce(refusedErr())
      .mockResolvedValueOnce("ok");

    const p = refusedStreamRetry(next)(unaryReq());
    await vi.runAllTimersAsync();

    await expect(p).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-REFUSED error", async () => {
    const next = vi.fn().mockRejectedValue(new Error("permission denied"));

    await expect(refusedStreamRetry(next)(unaryReq())).rejects.toThrow("permission denied");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry cap", async () => {
    vi.useFakeTimers();
    const next = vi.fn().mockRejectedValue(refusedErr());

    const p = refusedStreamRetry(next)(unaryReq());
    const assertion = expect(p).rejects.toThrow("NGHTTP2_REFUSED_STREAM");
    await vi.runAllTimersAsync();
    await assertion;

    expect(next).toHaveBeenCalledTimes(REFUSED_STREAM_MAX_RETRIES + 1);
  });

  it("passes streaming requests straight through without retrying", async () => {
    const next = vi.fn().mockRejectedValue(refusedErr());

    await expect(refusedStreamRetry(next)(streamReq())).rejects.toThrow("NGHTTP2_REFUSED_STREAM");
    expect(next).toHaveBeenCalledTimes(1);
  });
});

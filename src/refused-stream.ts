import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";

export const REFUSED_STREAM_MAX_RETRIES = 3;
export const REFUSED_STREAM_BACKOFF_MS = 150;

const HTTP2_TRANSIENT_CODES = ["NGHTTP2_REFUSED_STREAM", "ERR_HTTP2_GOAWAY_SESSION"];

// isRefusedStreamOrGoAway reports whether err (or any error within a few levels
// of its cause chain) is an HTTP/2 REFUSED_STREAM or GOAWAY.
export function isRefusedStreamOrGoAway(err: unknown): boolean {
  const describe = (e: unknown): string =>
    e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e ?? "");
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth++ < 4) {
    const s = describe(cur);
    if (/REFUSED_STREAM|GOAWAY/i.test(s) || HTTP2_TRANSIENT_CODES.some((c) => s.includes(c))) {
      return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return false;
}

// Only use this when replay or an idempotent fallback is safe.
export function isRetryableStreamTransportError(err: unknown): boolean {
  if (isRefusedStreamOrGoAway(err)) return true;
  const connectErr = err instanceof ConnectError ? err : ConnectError.from(err);
  if (connectErr.code !== Code.Aborted && connectErr.code !== Code.Unavailable) return false;
  return /ECONNRESET|connection reset|socket hang up|unexpected EOF|stream closed before headers/i.test(
    connectErr.message,
  );
}

export class WaitStreamEndedError extends Error {}

// Connection-level HTTP/2 failures that clients report under any code.
// Keep these markers in sync with the Go and Python SDKs.
const WAIT_CONNECTION_MARKERS = /refused_stream|refused stream|goaway|too_many_pings|enhance_your_calm/i;

// Markers for HTTP/2 and proxy failures across connect-go, connect-node and grpc-core.
const WAIT_TRANSPORT_MARKERS =
  /http2:|rst_stream|stream reset|stream error|stream removed|stream closed|internal_error|econnreset|connection reset|connection lost|i\/o timeout|socket closed|socket hang up|unexpected eof|missing status|no grpc-status trailer|incomplete envelope|server closed|transport closing|timeout awaiting response headers|upstream request timeout/i;

// Readiness is safe to recover by polling; command streams must not be replayed.
export function isRetryableWaitStreamError(err: unknown): boolean {
  if (err instanceof WaitStreamEndedError) return true;
  const error = err instanceof ConnectError ? err : ConnectError.from(err);
  return error.code === Code.Unimplemented || isTransientWaitError(err);
}

export function isRetryableWaitPollError(err: unknown): boolean {
  const error = err instanceof ConnectError ? err : ConnectError.from(err);
  return error.code === Code.NotFound || isTransientWaitError(err);
}

// Callers must rule out their own cancellation before treating Canceled as transient.
function isTransientWaitError(err: unknown): boolean {
  // Only RPC errors qualify: a terminal-state error may quote transport text from the server.
  if (!(err instanceof ConnectError)) return false;
  if (err.code === Code.Unavailable || err.code === Code.DeadlineExceeded) return true;
  const chain: unknown[] = [];
  for (let current: unknown = err; current && chain.length < 4; current = (current as { cause?: unknown }).cause) {
    chain.push(current);
  }
  const messages = chain.map((e) => (e instanceof Error ? e.message : String(e)));
  if (isRefusedStreamOrGoAway(err) || messages.some((m) => WAIT_CONNECTION_MARKERS.test(m))) return true;
  // connect reports a stream cut by GOAWAY as an incomplete envelope.
  const protocolError = err.code === Code.InvalidArgument && messages.some((m) => /protocol error/i.test(m));
  if (!protocolError && ![Code.Internal, Code.Aborted, Code.Unknown, Code.Canceled].includes(err.code)) return false;
  if (chain.some((e) => e instanceof ConnectError && e.code === Code.DeadlineExceeded)) return true;
  return messages.some((m) => WAIT_TRANSPORT_MARKERS.test(m));
}

function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export const refusedStreamRetry: Interceptor = (next) => async (req) => {
  if (req.stream) return next(req);
  for (let attempt = 0; ; attempt++) {
    try {
      return await next(req);
    } catch (err) {
      if (attempt >= REFUSED_STREAM_MAX_RETRIES || !isRefusedStreamOrGoAway(err)) throw err;
      await sleep(jitter(REFUSED_STREAM_BACKOFF_MS * (attempt + 1)), req.signal);
    }
  }
};

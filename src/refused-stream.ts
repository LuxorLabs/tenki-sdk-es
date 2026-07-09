import type { Interceptor } from "@connectrpc/connect";

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

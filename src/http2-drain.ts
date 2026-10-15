import type http2 from "node:http2";
import { Http2SessionManager } from "@connectrpc/connect-node";

export const isBunRuntime = typeof (process.versions as { bun?: string }).bun === "string";

// Matches the Go SDK's HTTP/2 ReadIdleTimeout/PingTimeout so a dead connection fails within ~35s.
export const KEEPALIVE_PING_OPTIONS = { pingIntervalMs: 30_000, pingTimeoutMs: 5_000 };

// Bun's node:http2 client destroys a stream as soon as END_STREAM arrives, even when
// DATA frames coalesced into the same socket read are still buffered, so the reader
// fails with ERR_STREAM_PREMATURE_CLOSE (oven-sh/bun#14249; still present in Bun 1.4.0).
// Node defers the destroy until the consumer drains the buffer; this restores that.
export function deferDestroyUntilDrained(stream: http2.ClientHttp2Stream): void {
  const destroy = stream.destroy.bind(stream);
  stream.destroy = ((err?: Error) => {
    const cleanClose = !err && (stream.rstCode === undefined || stream.rstCode === 0);
    if (!cleanClose || stream.readableEnded || stream.readableLength === 0) return destroy(err);
    stream.once("end", () => {
      if (!stream.destroyed) destroy();
    });
    stream.read(0);
    return stream;
  }) as typeof stream.destroy;
}

// Runtime-compatibility boundary: every stream the connect-node transport opens goes
// through request(), so this is the one place the Bun drain fix can be applied.
export class DrainingHttp2SessionManager extends Http2SessionManager {
  private readonly configuredSessions = new WeakSet<http2.Http2Session>();

  constructor(
    url: URL | string,
    pingOptions?: ConstructorParameters<typeof Http2SessionManager>[1],
    http2SessionOptions?: ConstructorParameters<typeof Http2SessionManager>[2],
    private readonly drain: boolean = isBunRuntime,
    // Bun's setLocalWindowSize stalls every response larger than the default 64 KiB window.
    private readonly enlargeWindow: boolean = !isBunRuntime,
  ) {
    super(url, pingOptions, http2SessionOptions);
  }

  override async request(
    method: string,
    path: string,
    headers: http2.OutgoingHttpHeaders,
    options: Omit<http2.ClientSessionRequestOptions, "signal">,
  ): Promise<http2.ClientHttp2Stream> {
    const stream = await super.request(method, path, headers, options);
    const session = stream.session;
    if (session && !session.destroyed && !session.closed && !this.configuredSessions.has(session)) {
      this.configuredSessions.add(session);
      // connect-node can destroy a session for a PING timeout after it detached its own error
      // listener; streams still observe the failure, so keep the late session error from crashing.
      session.on("error", () => {});
      if (this.enlargeWindow) {
        try {
          // Concurrent streams share the connection's receive window.
          session.setLocalWindowSize(Math.max(session.state.effectiveLocalWindowSize ?? 0, 16 * 1024 * 1024));
        } catch {
          // Keep the default window rather than failing a stream that is already open.
        }
      }
    }
    if (this.drain) deferDestroyUntilDrained(stream);
    return stream;
  }
}

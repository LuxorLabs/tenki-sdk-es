import type http2 from "node:http2";
import { Http2SessionManager } from "@connectrpc/connect-node";

export const isBunRuntime = typeof (process.versions as { bun?: string }).bun === "string";

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
  constructor(
    url: URL | string,
    pingOptions?: ConstructorParameters<typeof Http2SessionManager>[1],
    http2SessionOptions?: ConstructorParameters<typeof Http2SessionManager>[2],
    private readonly drain: boolean = isBunRuntime,
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
    if (this.drain) deferDestroyUntilDrained(stream);
    return stream;
  }
}

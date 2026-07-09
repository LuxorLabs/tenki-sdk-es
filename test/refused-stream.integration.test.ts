import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createDataPlaneClient, DataPlaneCredentialManager } from "../src/data-plane.js";
import { REFUSED_STREAM_MAX_RETRIES } from "../src/refused-stream.js";

// End-to-end exercise of Patch 1 against the REAL @connectrpc/connect-node
// gRPC transport (h2c) — not a mocked `next`. A local HTTP/2 server refuses the
// first N stream opens with RST_STREAM(NGHTTP2_REFUSED_STREAM), exactly like the
// data-plane edge (Caddy) does while reloading on session churn, then answers a
// later stream with a valid unary gRPC response.

interface FakeServer {
  url: string;
  streamCount(): number;
  close(): Promise<void>;
}

// startServer refuses the first `failures` stream opens, then replies OK.
async function startServer(failures: number): Promise<FakeServer> {
  let count = 0;
  const server = http2.createServer();

  server.on("stream", (stream) => {
    count++;
    stream.on("error", () => {});
    stream.on("data", () => {}); // drain the request body

    if (count <= failures) {
      stream.close(http2.constants.NGHTTP2_REFUSED_STREAM); // RST_STREAM, never processed
      return;
    }

    // Minimal valid unary gRPC reply: empty length-prefixed message + grpc-status 0.
    stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.end(Buffer.from([0, 0, 0, 0, 0]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    streamCount: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fakeCredentials(): DataPlaneCredentialManager {
  return new DataPlaneCredentialManager({ renewDataPlaneCredential: async () => true } as never);
}

describe("refusedStreamRetry (integration, real connect-node transport)", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("transparently recovers from REFUSED_STREAM on stream open", async () => {
    server = await startServer(2); // refuse twice, then succeed
    const client = createDataPlaneClient(server.url, fakeCredentials());

    await expect(client.stat({ path: "/" })).resolves.toBeDefined();
    expect(server.streamCount()).toBe(3); // 2 refusals + 1 success
  });

  it("gives up after the retry cap when REFUSED_STREAM never clears", async () => {
    server = await startServer(Number.POSITIVE_INFINITY); // always refuse
    const client = createDataPlaneClient(server.url, fakeCredentials());

    await expect(client.stat({ path: "/" })).rejects.toThrow();
    expect(server.streamCount()).toBe(REFUSED_STREAM_MAX_RETRIES + 1); // initial + 3 retries
  });
});

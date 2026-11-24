import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createDataPlaneClient, DataPlaneCredentialManager } from "../src/data-plane.js";

// Sessions on one data-plane host share a single HTTP/2 connection. Several large unary
// writes in flight on it must not trip the client's session memory cap, which makes Node
// and Bun reset the next response with NGHTTP2_ENHANCE_YOUR_CALM.

const CONCURRENT_WRITES = 8;

interface FakeServer {
  url: string;
  close(): Promise<void>;
}

// Replies only after the whole request body arrives, so the client keeps several large
// bodies queued on the connection while the first responses come back.
async function startServer(): Promise<FakeServer> {
  const server = http2.createServer({ settings: { initialWindowSize: 1024 * 1024 } });
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });

  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.on("error", () => {});
    stream.on("data", () => {});
    stream.on("end", () => {
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 0]));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  };
}

function fakeCredentials(): DataPlaneCredentialManager {
  return new DataPlaneCredentialManager({ renewDataPlaneCredential: async () => true } as never);
}

describe("data-plane session memory (integration, real connect-node transport)", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it.each([
    { label: "8 MiB", chunkBytes: 8 * 1024 * 1024 },
    { label: "max-size 32 MiB", chunkBytes: 32 * 1024 * 1024 },
  ])(
    "completes concurrent $label writes from several sessions on one shared connection",
    async ({ chunkBytes }) => {
      server = await startServer();
      const content = new Uint8Array(chunkBytes);
      const writes = Array.from({ length: CONCURRENT_WRITES }, (_, i) => {
        const sessionId = `session-${i % 4}`;
        const client = createDataPlaneClient(server!.url, fakeCredentials(), sessionId);
        return client.writeFile({ request: { sessionId, path: `/home/tenki/part-${i}`, content } });
      });

      await expect(Promise.all(writes)).resolves.toHaveLength(CONCURRENT_WRITES);
    },
    30_000,
  );
});

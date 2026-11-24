import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { closeDataPlaneConnection, createDataPlaneClient, DataPlaneCredentialManager } from "../src/data-plane.js";
import { run } from "../src/process.js";
import type { Session } from "../src/session.js";

// A stream can end with RST_STREAM(NO_ERROR) before any response reaches connect-node: a peer
// resets it early, or Node drops the response headers while over maxSessionMemory. connect-node
// only rejects on non-zero reset codes, so without a guard the RPC never settles.

interface FakeServer {
  url: string;
  close(): Promise<void>;
}

async function startServer(): Promise<FakeServer> {
  const server = http2.createServer();
  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.on("error", () => {});
    stream.close(http2.constants.NGHTTP2_NO_ERROR);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function fakeCredentials(): DataPlaneCredentialManager {
  return new DataPlaneCredentialManager({ renewDataPlaneCredential: async () => true } as never);
}

const HUNG = Symbol("hung");
const settleWithin = <T>(promise: Promise<T>, ms = 5_000) =>
  Promise.race([promise, new Promise<typeof HUNG>((resolve) => setTimeout(() => resolve(HUNG), ms))]);

describe("stream closed without a response (integration, real connect-node transport)", () => {
  let server: FakeServer | undefined;
  let client: ReturnType<typeof createDataPlaneClient> | undefined;

  afterEach(async () => {
    // Close the client first; its cached HTTP/2 session keeps server.close() waiting until it idles out.
    closeDataPlaneConnection(client);
    client = undefined;
    await server?.close();
    server = undefined;
  });

  it("rejects a unary call instead of hanging", async () => {
    server = await startServer();
    client = createDataPlaneClient(server.url, fakeCredentials(), "session-1");

    const outcome = await settleWithin(
      client.writeFile({ request: { sessionId: "session-1", path: "/home/tenki/a", content: new Uint8Array(4) } }).then(
        () => "resolved",
        (err: unknown) => err,
      ),
    );

    expect(outcome).not.toBe(HUNG);
    expect(String(outcome)).toMatch(/closed without a response/);
  });

  it("rejects a command run instead of hanging", async () => {
    server = await startServer();
    const dataPlane = createDataPlaneClient(server.url, fakeCredentials(), "session-1");
    client = dataPlane;
    const session = {
      id: "session-1",
      dataPlaneReadyBudgetMs: () => 2_000,
      requireDataPlane: async () => dataPlane,
      markDataPlaneServing: () => {},
      reauthOnUnauthenticated: async () => false,
      dataPlaneProvisioningPending: () => false,
      refreshHintedDataPlane: async () => false,
    } as unknown as Session;

    const proc = run(session, ["true"]);
    void proc.stdin.close().catch(() => {});
    const outcome = await settleWithin(
      Promise.resolve(proc).then(
        () => "resolved",
        (err: unknown) => err,
      ),
    );

    expect(outcome).not.toBe(HUNG);
    expect(String(outcome)).toMatch(/closed without a response/);
  });
});

import { readFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";

import { setAuthHeaders } from "../src/auth.js";
import { TenkiSandbox } from "../src/index.js";
import {
  SandboxService,
  SandboxSessionDataPlaneService,
  SandboxSessionSchema,
  SessionCredentialSchema,
  SessionState,
  TerminateSessionResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const expected = {
  "x-tenki-client-family": "typescript",
  "x-tenki-client-version": version,
  "x-tenki-client-generation": "1",
  "x-tenki-client-runtime": `node/${process.versions.node}`,
};

function metadataOf(headers: Headers): Record<string, string | null> {
  return Object.fromEntries(Object.keys(expected).map((name) => [name, headers.get(name)]));
}

async function listen(server: http2.Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("client metadata headers", () => {
  it("rides the SSH WebSocket upgrade headers", () => {
    const headers = new Headers();
    setAuthHeaders(headers, "tk_test");
    expect(metadataOf(headers)).toEqual(expected);
  });

  it("reaches the control plane", async () => {
    let received: Headers | undefined;
    const server = http2.createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(SandboxService, {
            getSessionMetrics(_request, context) {
              received = context.requestHeader;
              return {};
            },
          });
        },
      }),
    );
    const client = new TenkiSandbox({ authToken: "tk_test", baseUrl: await listen(server) });
    try {
      await client.getSessionMetrics("session-1");
      expect(metadataOf(received!)).toEqual(expected);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reaches the data plane", async () => {
    let received: Headers | undefined;
    const server = http2.createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(SandboxSessionDataPlaneService, {
            stat(_request, context) {
              received = context.requestHeader;
              return {};
            },
          });
        },
      }),
    );
    const endpoint = await listen(server);
    const session = new Session(
      { terminateSession: async () => create(TerminateSessionResponseSchema) } as never,
      create(SandboxSessionSchema, { id: "session-1", state: SessionState.RUNNING }),
      "tk_test",
      "test-gateway",
      undefined,
      60_000,
      { endpoint, credential: create(SessionCredentialSchema, { credential: "data-plane-credential" }) },
    );
    try {
      const dataPlane = await session.requireDataPlane(false);
      await dataPlane.stat({ request: { sessionId: "session-1", path: "/" } });
      expect(received?.get("x-tenki-session-cert")).toBe("data-plane-credential");
      expect(metadataOf(received!)).toEqual(expected);
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

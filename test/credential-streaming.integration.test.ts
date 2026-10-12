import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";

import {
  CreateSessionCredentialResponseSchema,
  SandboxSessionDataPlaneService,
  SandboxSessionSchema,
  SessionCredentialSchema,
  SessionState,
  TerminateSessionResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

const cases = [
  ["run", "start"],
  ["dial", "open"],
  ["hostPortTunnel", "open"],
  ["writeFileStream", "start"],
] as const;

describe("stream credential session binding over gRPC", () => {
  it.each(cases)("%s refuses foreign session frames and accepts its own", async (method, opening) => {
    const received: unknown[] = [];
    async function consume(request: AsyncIterable<unknown>) {
      for await (const frame of request) received.push(frame);
    }
    async function* stream(request: AsyncIterable<unknown>) {
      await consume(request);
      yield {};
    }
    const server = http2.createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(SandboxSessionDataPlaneService, {
            run: stream,
            dial: stream,
            hostPortTunnel: stream,
            writeFileStream: async (request) => {
              await consume(request);
              return {};
            },
          });
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const session = new Session(
      {
        createSessionCredential: async () =>
          create(CreateSessionCredentialResponseSchema, {
            credential: create(SessionCredentialSchema, { credential: "renewed-stream-credential" }),
          }),
        terminateSession: async () => create(TerminateSessionResponseSchema),
      } as never,
      create(SandboxSessionSchema, { id: "session-1", state: SessionState.RUNNING }),
      "test-api-token",
      "test-gateway",
      undefined,
      60_000,
      { endpoint, credential: create(SessionCredentialSchema, { credential: "stream-credential" }) },
    );
    const client = await session.requireDataPlane(false);
    async function call(sessionIds: string[]) {
      async function* frames() {
        for (const sessionId of sessionIds) {
          yield { frame: { payload: { case: opening, value: { sessionId } } } };
        }
      }
      if (method === "writeFileStream") {
        await client.writeFileStream(frames() as never);
      } else {
        for await (const _ of client[method](frames() as never)) {
          /* consume response */
        }
      }
    }
    try {
      await expect(call(["other-session"])).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectError && err.code === Code.PermissionDenied,
      );
      expect(received).toHaveLength(0);
      await expect(call(["session-1"])).resolves.toBeUndefined();
      expect(received).toHaveLength(1);
      await expect(session.renewDataPlaneCredential()).resolves.toBe(true);
      await expect(call(["session-1"])).resolves.toBeUndefined();
      expect(received).toHaveLength(2);
      received.length = 0;
      await expect(call(["session-1", "other-session"])).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectError && err.code === Code.PermissionDenied,
      );
      expect(JSON.stringify(received)).not.toContain("other-session");
    } finally {
      await session.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

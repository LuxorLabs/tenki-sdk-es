import { once } from "node:events";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { connectNodeAdapter, createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { expect, it, vi } from "vitest";

import {
  SandboxService,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

it.each([SessionState.RUNNING, SessionState.TERMINATED])(
  "releases the readiness deadline for state %s",
  async (state) => {
    const server = createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(SandboxService, {
            async *waitSession() {
              yield { session: { id: "session-1", state } };
            },
          });
        },
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const manager = new Http2SessionManager(baseUrl);
    const rpc = createClient(
      SandboxService,
      createGrpcTransport({ baseUrl, httpVersion: "2", sessionManager: manager }),
    );
    const session = new Session(
      rpc,
      create(SandboxSessionSchema, { id: "session-1", state: SessionState.CREATING }),
      "",
      "",
    );
    const scheduled = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    try {
      if (state === SessionState.RUNNING) {
        await session.waitReady();
      } else {
        await expect(session.waitReady()).rejects.toThrow("session entered terminal state");
      }
      const deadlines = scheduled.mock.calls.flatMap((args, index) =>
        args[1] === 180_000 ? [scheduled.mock.results[index]!.value] : [],
      );
      expect(deadlines.length).toBeGreaterThan(0);
      for (const deadline of deadlines) expect(cleared).toHaveBeenCalledWith(deadline);
    } finally {
      for (const [index, args] of scheduled.mock.calls.entries()) {
        if (args[1] === 180_000) clearTimeout(scheduled.mock.results[index]!.value);
      }
      scheduled.mockRestore();
      cleared.mockRestore();
      manager.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

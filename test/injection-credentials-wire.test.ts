import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { create, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { expect, it } from "vitest";

import { InjectionCredentialInput, TemplateRuntimeFailedError, TenkiSandbox } from "../src/index.js";
import {
  SandboxService,
  SessionState,
  TemplateRuntimeFailureSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  RevokeSessionInjectionCredentialRequestSchema,
  SetSessionInjectionCredentialRequestSchema,
} from "../src/internal/proto/tenki/sandbox/v1/session_injection_credentials_pb.js";

it("sends atomic create and revision presence over authenticated transport", async () => {
  const canary = "SYNTHETIC_CANARY_P4_NOT_A_CREDENTIAL";
  const calls: unknown[] = [];
  let code: Code | undefined;
  const metadata = { credentialId: "credential-synthetic", name: "SYNTHETIC", revision: 7 };
  const server = http2.createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(SandboxService, {
          createSessionWithInjectionCredentials(req, ctx) {
            expect(ctx.requestHeader.get("authorization")).toBe("Bearer tk_test");
            expect(req.session?.name).toBe("synthetic");
            expect(req.credentials[0]?.value).toEqual(new TextEncoder().encode(canary));
            expect(req.credentials[0]?.rules[0]?.pathPrefix).toBe("/repo");
            calls.push("create");
            if (code === Code.FailedPrecondition)
              throw new ConnectError(canary, code, undefined, [
                {
                  desc: TemplateRuntimeFailureSchema,
                  value: create(TemplateRuntimeFailureSchema, {
                    reason: canary,
                    session: { id: "session-synthetic", state: SessionState.RUNNING, metadata: { echo: canary } },
                  }),
                },
              ]);
            return {
              created: { session: { id: "session-synthetic", state: SessionState.RUNNING } },
              credentials: [metadata],
            };
          },
          setSessionInjectionCredential(req) {
            calls.push(toJson(SetSessionInjectionCredentialRequestSchema, req));
            if (code) throw new ConnectError(canary, code);
            return { credential: metadata };
          },
          revokeSessionInjectionCredential(req) {
            calls.push(toJson(RevokeSessionInjectionCredentialRequestSchema, req));
            return { credential: { ...metadata, revoked: true } };
          },
        });
      },
    }),
  );
  const connections = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    connections.add(session);
    session.on("close", () => connections.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new TenkiSandbox({
    authToken: "tk_test",
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const input = new InjectionCredentialInput("SYNTHETIC", new TextEncoder().encode(canary), [
    { origin: "https://example.invalid", methods: ["GET"], pathPrefix: "/repo", header: "Authorization" },
  ]);
  try {
    const { session } = await client.createWithInjectionCredentials([input], { name: "synthetic" });
    for (const revision of [undefined, 0, 7]) {
      await session.setInjectionCredential(input, revision);
      await session.revokeInjectionCredential(input.name, revision);
      for (const call of calls.slice(-2) as Record<string, unknown>[]) {
        expect(Object.hasOwn(call, "expectedRevision")).toBe(revision !== undefined);
        expect(call.expectedRevision).toBe(revision);
        expect(call.sessionId).toBe(session.id);
      }
    }
    for (const status of [Code.PermissionDenied, Code.FailedPrecondition, Code.Aborted]) {
      code = status;
      try {
        await session.setInjectionCredential(input);
        throw new Error("expected failure");
      } catch (error) {
        expect(String(error)).not.toContain(canary);
        expect((error as Error).cause).toMatchObject({ code: status });
      }
    }
    code = Code.FailedPrecondition;
    try {
      await client.createWithInjectionCredentials([input], { name: "synthetic" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateRuntimeFailedError);
      expect((error as TemplateRuntimeFailedError).session.id).toBe("session-synthetic");
      expect(inspect(error, { depth: 10 }).includes(canary)).toBe(false);
    }
  } finally {
    client.close();
    for (const session of connections) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

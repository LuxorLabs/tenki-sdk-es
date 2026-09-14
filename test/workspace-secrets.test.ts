import { once } from "node:events";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { create, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";

import { WorkspaceClient, type SecretPolicy } from "../src/index.js";
import * as pb from "../src/internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";

const policy: SecretPolicy = { deliveryMode: "guest_and_injection", destinationMode: "unset" };
const secret = create(pb.SecretSchema, {
  id: "secret",
  workspaceId: "workspace",
  name: "TOKEN",
  revision: 2,
  activeVersion: 1,
  policy: { deliveryMode: pb.SecretDeliveryMode.GUEST_AND_INJECTION, destinationMode: pb.SecretDestinationMode.UNSET },
});

describe("workspace secrets wire contract", () => {
  it.each(["workspace", ""])("preserves the wire contract with workspace scope %j", async (workspaceId) => {
    const requests: Message[] = [];
    const server = createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(pb.WorkspaceSecretsService, {
            createSecret(request, context) {
              expect(context.requestHeader.get("authorization")).toBe("Bearer tk_test");
              requests.push(request);
              return { secret };
            },
            updateSecret(request) {
              requests.push(request);
              return { secret };
            },
            getSecret(request) {
              requests.push(request);
              return { secret };
            },
            listSecrets(request) {
              requests.push(request);
              return { secrets: [secret], nextCursor: "next" };
            },
            listSecretVersions(request) {
              requests.push(request);
              return { versions: [{ version: 1 }], nextCursor: "versions-next" };
            },
            revokeSecret(request) {
              requests.push(request);
              return { secret };
            },
            deleteSecret(request) {
              requests.push(request);
              return { secret };
            },
          });
        },
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const client = new WorkspaceClient({
      workspaceId,
      authToken: "tk_test",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    try {
      const value = new Uint8Array([0, 255, 10, 128]);
      const result = await client.secrets.create("TOKEN", value, policy, "00000000-0000-4000-8000-000000000001");
      await client.secrets.create("EMPTY", new Uint8Array(), policy);
      await client.secrets.update("secret", { expectedRevision: 2 });
      await client.secrets.update("secret", {
        expectedRevision: 2,
        value: new Uint8Array(),
        requestId: "00000000-0000-4000-8000-000000000003",
      });
      await client.secrets.update("secret", {
        expectedRevision: 2,
        activeVersion: 1,
        requestId: "00000000-0000-4000-8000-000000000006",
      });
      await client.secrets.get("secret");
      const pageOptions = { pageSize: 2, cursor: "current", workspaceId: "must-not-override-scope" };
      expect((await client.secrets.list(pageOptions)).nextCursor).toBe("next");
      expect((await client.secrets.listVersions("secret", { cursor: "current" })).versions).toEqual([
        { version: 1, createdAt: undefined, revokedAt: undefined },
      ]);
      await client.secrets.revoke("secret", { expectedRevision: 2 });
      await client.secrets.revoke("secret", {
        expectedRevision: 2,
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000004",
      });
      await client.secrets.delete("secret", { expectedRevision: 2, requestId: "00000000-0000-4000-8000-000000000005" });
      expect(requests[0]).toMatchObject({ workspaceId, value, requestId: "00000000-0000-4000-8000-000000000001" });
      expect(requests[1]).toMatchObject({ workspaceId, value: new Uint8Array() });
      expect((requests[1] as pb.CreateSecretRequest).requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect((requests[2] as pb.UpdateSecretRequest).value).toBeUndefined();
      expect(requests[3]).toMatchObject({
        value: new Uint8Array(),
        expectedRevision: 2,
        requestId: "00000000-0000-4000-8000-000000000003",
      });
      expect(requests[4]).toMatchObject({ activeVersion: 1, requestId: "00000000-0000-4000-8000-000000000006" });
      expect((requests[8] as pb.RevokeSecretRequest).version).toBeUndefined();
      expect(requests[9]).toMatchObject({
        version: 1,
        expectedRevision: 2,
        requestId: "00000000-0000-4000-8000-000000000004",
      });
      expect(requests[10]).toMatchObject({ expectedRevision: 2, requestId: "00000000-0000-4000-8000-000000000005" });
      for (const request of requests) expect(request).toMatchObject({ workspaceId });
      expect(result).not.toHaveProperty("value");
      expect(result).not.toHaveProperty("ciphertext");
      expect(result.policy).toEqual({ ...policy, allowedHosts: [] });
    } finally {
      await client[Symbol.asyncDispose]();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([Code.Aborted, Code.NotFound, Code.PermissionDenied, Code.Unauthenticated, Code.AlreadyExists])(
    "retains RPC status %s and caller request ID after an uncertain result",
    async (code) => {
      const seen: string[] = [];
      const server = createServer(
        connectNodeAdapter({
          routes(router) {
            router.service(pb.WorkspaceSecretsService, {
              updateSecret(request) {
                seen.push(request.requestId);
                throw new ConnectError("request failed", code);
              },
            });
          },
        }),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const client = new WorkspaceClient({
        workspaceId: "workspace",
        authToken: "tk_test",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(
            client.secrets.update("secret", { expectedRevision: 1, requestId: "00000000-0000-4000-8000-000000000002" }),
          ).rejects.toMatchObject({ name: "WorkspaceSecretError", code });
        }
        expect(seen).toEqual(["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000002"]);
      } finally {
        await client[Symbol.asyncDispose]();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

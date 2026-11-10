import { once } from "node:events";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { create, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";

import { WorkspaceClient } from "../src/index.js";
import * as pb from "../src/internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";

const secret = create(pb.SecretSchema, {
  id: "secret",
  workspaceId: "workspace",
  name: "TOKEN",
  revision: 2,
  activeVersion: 1,
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
              return { secret: { ...secret, repository: request.repository, description: request.description } };
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
            listSecretRepositories(request) {
              requests.push(request);
              return { repositories: [{ fullName: "acme/api" }], nextCursor: "acme/api" };
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
      const result = await client.secrets.create("TOKEN", value, "00000000-0000-4000-8000-000000000001");
      await client.secrets.create("EMPTY", new Uint8Array());
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
      const scoped = await client.secrets.create("SCOPED", value, {
        repository: "acme/api",
        description: "Deploy token",
        requestId: "00000000-0000-4000-8000-000000000007",
      });
      expect(requests[0]).toMatchObject({
        workspaceId,
        value,
        requestId: "00000000-0000-4000-8000-000000000001",
        repository: "",
      });
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
      expect(requests[11]).toMatchObject({
        name: "SCOPED",
        value,
        repository: "acme/api",
        description: "Deploy token",
        requestId: "00000000-0000-4000-8000-000000000007",
      });
      expect(result.repository).toBeUndefined();
      expect(result.description).toBeUndefined();
      expect(scoped).toMatchObject({ repository: "acme/api", description: "Deploy token" });
      for (const repository of ["acme", "acme/api/extra", "/api"]) {
        await expect(client.secrets.create("TOKEN", value, { repository })).rejects.toThrow("owner/name");
      }
      expect(requests).toHaveLength(12);
      expect(await client.secrets.listRepositories({ pageSize: 1, cursor: "acme/a", search: "acme" })).toEqual({
        repositories: ["acme/api"],
        nextCursor: "acme/api",
      });
      expect(requests[12]).toMatchObject({ pageSize: 1, cursor: "acme/a", search: "acme" });
      await client.secrets.update("secret", {
        expectedRevision: 2,
        description: "",
        availability: "repository",
        repository: "acme/web",
      });
      await client.secrets.update("secret", { expectedRevision: 2, availability: "workspace" });
      await client.secrets.list({ availability: "repository", repository: "acme/api", cursor: "current" });
      expect(requests[13]).toMatchObject({
        description: "",
        availability: pb.SecretAvailability.REPOSITORY,
        repository: "acme/web",
      });
      expect(requests[14]).toMatchObject({ availability: pb.SecretAvailability.WORKSPACE });
      expect((requests[14] as pb.UpdateSecretRequest).description).toBeUndefined();
      expect(requests[15]).toMatchObject({
        availability: pb.SecretAvailability.REPOSITORY,
        repository: "acme/api",
        cursor: "current",
      });
      await expect(
        client.secrets.update("secret", { expectedRevision: 2, availability: "repository", repository: "acme" }),
      ).rejects.toThrow("owner/name");
      await expect(client.secrets.list({ availability: "everywhere" as never })).rejects.toThrow("availability");
      // A repository alone means repository availability, as in the CLI.
      await client.secrets.list({ repository: "acme/api" });
      await client.secrets.update("secret", { expectedRevision: 2, repository: "acme/web" });
      expect(requests[16]).toMatchObject({ availability: pb.SecretAvailability.REPOSITORY, repository: "acme/api" });
      expect(requests[17]).toMatchObject({ availability: pb.SecretAvailability.REPOSITORY, repository: "acme/web" });
      await expect(client.secrets.update("secret", { expectedRevision: 2, repository: "acme" })).rejects.toThrow(
        "owner/name",
      );
      await expect(client.secrets.list({ repository: "acme" })).rejects.toThrow("owner/name");
      await expect(
        client.secrets.update("secret", { expectedRevision: 2, availability: "workspace", repository: "acme/api" }),
      ).rejects.toThrow("cannot be combined");
      await expect(client.secrets.list({ availability: "workspace", repository: "acme/api" })).rejects.toThrow(
        "cannot be combined",
      );
      expect(requests).toHaveLength(18);
      for (const request of requests) expect(request).toMatchObject({ workspaceId });
      expect(result).not.toHaveProperty("value");
      expect(result).not.toHaveProperty("ciphertext");
      expect(result).not.toHaveProperty("policy");
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

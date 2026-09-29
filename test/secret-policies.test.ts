import { once } from "node:events";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { create, type Message } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { expect, it } from "vitest";

import { WorkspaceClient, type SecretRequestRule } from "../src/index.js";
import * as pb from "../src/internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";

it.each(["workspace", ""])("preserves policy CRUD wire semantics for workspace %j", async (workspaceId) => {
  const rules: SecretRequestRule[] = [
    {
      origin: "https://api.example.com",
      methods: ["POST"],
      pathPrefix: "/v1/",
      header: "Authorization",
      secrets: ["TOKEN", "SECOND"],
    },
  ];
  const policy = create(pb.SecretAccessPolicySchema, {
    id: "policy-id",
    workspaceId: "workspace",
    name: "claude",
    revision: 3,
    attachedSessionCount: 2,
    rules,
  });
  const requests: Message[] = [];
  let conflict = false;
  const server = createServer(
    connectNodeAdapter({
      routes(router) {
        router.service(pb.WorkspaceSecretsService, {
          createSecretPolicy(request, context) {
            expect(context.requestHeader.get("authorization")).toBe("Bearer tk_test");
            requests.push(request);
            return { policy };
          },
          updateSecretPolicy(request) {
            requests.push(request);
            if (conflict) throw new ConnectError("revision conflict", Code.Aborted);
            return { policy };
          },
          getSecretPolicy(request) {
            requests.push(request);
            return { policy };
          },
          listSecretPolicies(request) {
            requests.push(request);
            return { policies: [policy], nextCursor: "next" };
          },
          deleteSecretPolicy(request) {
            requests.push(request);
            return { policy };
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
  const requestId = "00000000-0000-4000-8000-000000000001";
  const options = { expectedRevision: 3, requestId, workspaceId: "must-not-override" };
  try {
    const policies = client.secrets.policies;
    const result = await policies.create("claude", rules, requestId);
    expect(result).toMatchObject({ name: "claude", revision: 3, attachedSessionCount: 2, rules });
    await policies.update(result.id, rules, options);
    await policies.get("claude");
    const page = await policies.list({ pageSize: 2, cursor: "current", ...options });
    expect(page.nextCursor).toBe("next");
    expect(page.policies).toHaveLength(1);
    await policies.delete(result.id, options);
    for (const request of requests) expect(request).toMatchObject({ workspaceId });
    expect(requests[0]).toMatchObject({ rules, requestId });
    expect(requests[1]).toMatchObject({ policyId: result.id, expectedRevision: 3, requestId, rules });
    expect(requests[2]).toMatchObject({ policyId: "claude" });
    expect(requests[3]).toMatchObject({ cursor: "current", pageSize: 2 });
    expect(requests[4]).toMatchObject({ policyId: result.id, expectedRevision: 3, requestId });
    conflict = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(policies.update(result.id, rules, options)).rejects.toMatchObject({ code: Code.Aborted });
    }
    expect(requests).toHaveLength(7);
    for (const request of requests.slice(5)) expect(request).toMatchObject({ requestId });
  } finally {
    await client[Symbol.asyncDispose]();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

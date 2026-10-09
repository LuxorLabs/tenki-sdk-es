import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  EgressPolicyNotFoundError,
  SessionExpiredError,
  SessionNotFoundError,
  TemplateNotFoundError,
  VolumeNotFoundError,
} from "../src/errors.js";
import {
  CreateEgressPolicyResponseSchema,
  DeleteEgressPolicyResponseSchema,
  EgressPolicySchema,
  GetEgressPolicyResponseSchema,
  ListEgressPoliciesResponseSchema,
  UpdateEgressPolicyResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

const connectMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(() => ({ kind: "transport" })),
  Http2SessionManager: vi.fn(function () {
    return { abort: vi.fn(), connect: vi.fn(async () => "idle") };
  }),
}));

vi.mock("@connectrpc/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@connectrpc/connect")>();
  return { ...actual, createClient: connectMock.createClient };
});

vi.mock("@connectrpc/connect-node", () => ({
  createGrpcTransport: connectMock.createGrpcTransport,
  Http2SessionManager: connectMock.Http2SessionManager,
}));

const createdAt = new Date("2026-10-08T09:00:00Z");

function policy(name: string) {
  return create(EgressPolicySchema, {
    id: `policy-${name}`,
    workspaceId: "ws-1",
    name,
    revision: 3,
    activeSessionCount: 2,
    egress: { allowDomains: ["github.com"], interceptHttps: true },
    createdAt: timestampFromDate(createdAt),
    updatedAt: timestampFromDate(createdAt),
  });
}

describe("egress policy CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the wire fields and maps the stored policy", async () => {
    const rpc = {
      createEgressPolicy: vi.fn(async (req: { name: string }) =>
        create(CreateEgressPolicyResponseSchema, { policy: policy(req.name) }),
      ),
      updateEgressPolicy: vi.fn(async () => create(UpdateEgressPolicyResponseSchema, { policy: policy("registries") })),
      getEgressPolicy: vi.fn(async () => create(GetEgressPolicyResponseSchema, { policy: policy("registries") })),
      listEgressPolicies: vi.fn(async (req: { cursor: string }) =>
        req.cursor
          ? create(ListEgressPoliciesResponseSchema, { policies: [policy("b")] })
          : create(ListEgressPoliciesResponseSchema, { policies: [policy("a")], nextCursor: "a" }),
      ),
      deleteEgressPolicy: vi.fn(async () =>
        create(DeleteEgressPolicyResponseSchema, {
          policy: { ...policy("registries"), deletedAt: timestampFromDate(createdAt) },
        }),
      ),
    };
    connectMock.createClient.mockReturnValue(rpc);
    const client = new TenkiSandbox({ authToken: "tk_test" });
    const spec = {
      allowDomains: ["github.com"],
      allowCidrs: ["10.0.0.0/8"],
      interceptHttps: true,
      httpRules: [{ domains: ["github.com"], methods: ["GET"], pathPrefix: "/repos/" }],
    };

    const created = await client.createEgressPolicy("registries", spec, { workspaceId: " ws-1 " });
    await client.updateEgressPolicy("registries", 3, spec);
    await client.getEgressPolicy("registries");
    const listed = await client.listEgressPolicies({ workspaceId: "ws-1" });
    const deleted = await client.deleteEgressPolicy("registries", 4);

    expect(created).toEqual({
      id: "policy-registries",
      workspaceId: "ws-1",
      name: "registries",
      revision: 3,
      activeSessionCount: 2,
      egress: { allowDomains: ["github.com"], allowCidrs: [], interceptHttps: true, httpRules: [], policyNames: [] },
      createdAt,
      updatedAt: createdAt,
      deletedAt: undefined,
    });
    const createReq = rpc.createEgressPolicy.mock.calls[0]?.[0] as Record<string, never>;
    expect(createReq).toMatchObject({ workspaceId: "ws-1", name: "registries" });
    expect(createReq.egress).toMatchObject({
      allowDomains: ["github.com"],
      allowCidrs: ["10.0.0.0/8"],
      interceptHttps: true,
      httpRules: [{ domains: ["github.com"], methods: ["GET"], path: { case: "prefix", value: "/repos/" } }],
    });
    const updateReq = rpc.updateEgressPolicy.mock.calls[0]?.[0] as { workspaceId?: string };
    expect(updateReq).toMatchObject({ policyId: "registries", expectedRevision: 3 });
    expect(updateReq.workspaceId).toBeUndefined();
    expect(rpc.getEgressPolicy.mock.calls[0]?.[0]).toMatchObject({ policyId: "registries" });
    expect(rpc.listEgressPolicies.mock.calls.map((call) => (call[0] as { cursor: string }).cursor)).toEqual(["", "a"]);
    expect(listed.map((item) => item.name)).toEqual(["a", "b"]);
    expect(rpc.deleteEgressPolicy.mock.calls[0]?.[0]).toMatchObject({ policyId: "registries", expectedRevision: 4 });
    expect(deleted.deletedAt).toEqual(createdAt);
  });

  it("maps a missing policy to EgressPolicyNotFoundError", async () => {
    connectMock.createClient.mockReturnValue({
      getEgressPolicy: vi.fn(async () => {
        throw new ConnectError("egress policy not found", Code.NotFound);
      }),
    });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const err = await client.getEgressPolicy("missing").catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(EgressPolicyNotFoundError);
    expect(err).not.toBeInstanceOf(SessionNotFoundError);
  });

  it.each(["egress policies not found: ci-template", "egress policies not found: volume-sync, artifact-store"])(
    "maps %j to EgressPolicyNotFoundError even when a name looks like another resource",
    async (message) => {
      connectMock.createClient.mockReturnValue({
        createSession: vi.fn(async () => {
          throw new ConnectError(message, Code.NotFound);
        }),
      });
      const client = new TenkiSandbox({ authToken: "tk_test" });

      const err = await client
        .create({ egressPolicies: ["ci-template"], waitReady: false })
        .catch((caught: unknown) => caught);

      expect(err).toBeInstanceOf(EgressPolicyNotFoundError);
      expect(err).not.toBeInstanceOf(TemplateNotFoundError);
      expect(err).not.toBeInstanceOf(VolumeNotFoundError);
      expect(err).not.toBeInstanceOf(SessionExpiredError);
    },
  );

  it("refuses a rule with two paths before calling the API", async () => {
    const createEgressPolicy = vi.fn();
    connectMock.createClient.mockReturnValue({ createEgressPolicy });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(
      client.createEgressPolicy("registries", {
        allowDomains: ["github.com"],
        interceptHttps: true,
        httpRules: [{ domains: ["github.com"], pathExact: "/a", pathRegex: "b" }],
      }),
    ).rejects.toThrow("only one of");
    expect(createEgressPolicy).not.toHaveBeenCalled();
  });
});

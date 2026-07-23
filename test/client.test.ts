import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { InvalidResourceConfigError } from "../src/errors.js";
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

const connectMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(() => ({ kind: "transport" })),
}));

vi.mock("@connectrpc/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@connectrpc/connect")>();
  return {
    ...actual,
    createClient: connectMock.createClient,
  };
});

vi.mock("@connectrpc/connect-node", () => ({
  createGrpcTransport: connectMock.createGrpcTransport,
}));

describe("TenkiSandbox client TLS options", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes root certificates to the default gRPC transport", () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";

    new TenkiSandbox({ authToken: "tk_test", rootCertificates });

    expect(connectMock.createGrpcTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeOptions: { ca: rootCertificates },
      }),
    );
  });

  it("rejects invalid create resources before RPC", async () => {
    const createSession = vi.fn();
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(client.create({ cpuCores: 17 })).rejects.toThrow(InvalidResourceConfigError);
    await expect(client.create({ memoryMb: 8089 })).rejects.toThrow(InvalidResourceConfigError);
    await expect(client.create({ diskSizeGb: 3 })).rejects.toThrow(InvalidResourceConfigError);

    expect(createSession).not.toHaveBeenCalled();
  });

  it("preserves no-argument create compatibility", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create();
    await client.createAndWait();

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[0]?.[0].workspaceId).toBeUndefined();
    expect(createSession.mock.calls[1]?.[0].workspaceId).toBeUndefined();
  });

  it("serializes default and explicit false outbound policy", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.CREATING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create({ waitReady: false });
    await client.create({ allowOutbound: false, waitReady: false });

    expect(createSession.mock.calls[0]?.[0].allowOutbound).toBe(true);
    expect(createSession.mock.calls[1]?.[0].allowOutbound).toBe(false);
    expect(createSession.mock.calls[0]?.[0].workspaceId).toBeUndefined();
    expect(toBinary(CreateSessionRequestSchema, create(CreateSessionRequestSchema, { allowOutbound: false }))).toEqual(
      new Uint8Array([0x20, 0x00]),
    );
  });

  it("serializes default and explicit false inbound policy", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.CREATING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create({ waitReady: false });
    await client.create({ allowInbound: false, waitReady: false });

    expect(createSession.mock.calls[0]?.[0].allowInbound).toBe(true);
    expect(createSession.mock.calls[1]?.[0].allowInbound).toBe(false);
    expect(toBinary(CreateSessionRequestSchema, create(CreateSessionRequestSchema, { allowInbound: false }))).toEqual(
      new Uint8Array([0x18, 0x00]),
    );
  });

  it("routes primary session and snapshot lists through Workspace RPCs", async () => {
    const listWorkspaceSandboxes = vi.fn(async () => ({ sessions: [] }));
    const listWorkspaceSnapshots = vi.fn(async () => ({ snapshots: [] }));
    connectMock.createClient.mockReturnValue({ listWorkspaceSandboxes, listWorkspaceSnapshots });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.list({ workspaceId: "workspace-1", sticky: true });
    await client.listSnapshots({ workspaceId: "workspace-1" });

    expect(listWorkspaceSandboxes).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", sticky: true }),
    );
    expect(listWorkspaceSnapshots).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" }));
  });

  it("rejects invalid template resources before RPC", async () => {
    const createTemplate = vi.fn();
    connectMock.createClient.mockReturnValue({ createTemplate });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 8089 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 128 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 4096, diskSizeGb: 4 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    expect(createTemplate).not.toHaveBeenCalled();
  });
});

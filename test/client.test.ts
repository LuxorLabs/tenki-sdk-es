import { create, toBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { InvalidAuthTokenError, InvalidResourceConfigError, WaitReadyFailedError } from "../src/errors.js";
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  SandboxSessionSchema,
  SandboxWarningCode,
  SandboxWarningSchema,
  SessionState,
  TerminateSessionResponseSchema,
  UpdateSessionResponseSchema,
  WaitSessionResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { SandboxWarningCodes } from "../src/warning.js";

const connectMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(() => ({ kind: "transport" })),
  sessionManagerConnect: vi.fn(async () => "idle"),
  sessionManagerAbort: vi.fn(),
  Http2SessionManager: vi.fn(function () {
    return { abort: connectMock.sessionManagerAbort, connect: connectMock.sessionManagerConnect };
  }),
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
  Http2SessionManager: connectMock.Http2SessionManager,
}));

describe("TenkiSandbox client TLS options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["ory_st_test", "arbitrary-value"])("rejects invalid credential %s", (authToken) => {
    expect(() => new TenkiSandbox({ authToken })).toThrow(InvalidAuthTokenError);
    expect(connectMock.createClient).not.toHaveBeenCalled();
  });

  it("passes root certificates to the default HTTP/2 session manager", () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";

    new TenkiSandbox({ authToken: "tk_test", rootCertificates });

    expect(connectMock.Http2SessionManager).toHaveBeenCalledWith(expect.any(String), undefined, {
      ca: rootCertificates,
    });
    expect(connectMock.createGrpcTransport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionManager: expect.any(Object) }),
    );
    expect(connectMock.sessionManagerConnect).toHaveBeenCalledOnce();
  });

  it("closes the control-plane session manager", () => {
    const client = new TenkiSandbox({ authToken: "tk_test" });

    client.close();

    expect(connectMock.sessionManagerAbort).toHaveBeenCalledOnce();
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

  it("retains and emits create warnings once", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [
          create(SandboxWarningSchema, {
            code: SandboxWarningCode.STICKY_OVERRIDES_MAX_DURATION,
            message: "sticky overrides max_duration",
          }),
        ],
      }),
    );
    const warningHandler = vi.fn();
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test", warningHandler });

    const session = await client.create();

    expect(session.warnings).toEqual([
      { code: SandboxWarningCodes.STICKY_OVERRIDES_MAX_DURATION, message: "sticky overrides max_duration" },
    ]);
    expect(warningHandler).toHaveBeenCalledOnce();
    expect(warningHandler).toHaveBeenCalledWith(session.warnings[0]);
  });

  it("isolates data-plane endpoint hints between sessions", async () => {
    let sessionNumber = 0;
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: `session-${++sessionNumber}`,
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const first = await client.create({ waitReady: false });
    const second = await client.create({ waitReady: false });
    const firstHints = Reflect.get(first, "dataPlaneEndpointHints") as { remember(endpoint: string): void };
    const secondHints = Reflect.get(second, "dataPlaneEndpointHints") as { current(): string };
    firstHints.remember("https://node.test");

    expect(secondHints.current()).toBe("");
  });

  it("uses the default warning handler and allows suppression", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [create(SandboxWarningSchema, { message: "sticky overrides max_duration" })],
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await new TenkiSandbox({ authToken: "tk_test" }).create();
    await new TenkiSandbox({ authToken: "tk_test", warningHandler: null }).create();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      `tenki sandbox warning [${SandboxWarningCodes.UNSPECIFIED}]: sticky overrides max_duration`,
    );
  });

  it("returns a session when a warning handler throws", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [
          create(SandboxWarningSchema, {
            code: SandboxWarningCode.STICKY_OVERRIDES_MAX_DURATION,
            message: "sticky overrides max_duration",
          }),
        ],
      }),
    );
    const warningHandlerError = new Error("handler failed");
    const warningHandler = vi.fn(() => {
      throw warningHandlerError;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectMock.createClient.mockReturnValue({ createSession });

    const session = await new TenkiSandbox({ authToken: "tk_test", warningHandler }).create();

    expect(session.id).toBe("session-1");
    expect(session.warnings).toEqual([
      { code: SandboxWarningCodes.STICKY_OVERRIDES_MAX_DURATION, message: "sticky overrides max_duration" },
    ]);
    expect(warningHandler).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("tenki sandbox warning handler failed", warningHandlerError);
  });

  it("maps unknown warning codes to unspecified", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [create(SandboxWarningSchema, { code: 999 as SandboxWarningCode, message: "unknown warning" })],
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });

    const session = await new TenkiSandbox({ authToken: "tk_test", warningHandler: null }).create();

    expect(session.warnings).toEqual([{ code: SandboxWarningCodes.UNSPECIFIED, message: "unknown warning" }]);
  });

  it("retains and emits update warnings", async () => {
    const updateSession = vi.fn(async () =>
      create(UpdateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [
          create(SandboxWarningSchema, {
            code: SandboxWarningCode.MAX_DURATION_CAPPED,
            message: "max_duration was capped",
          }),
        ],
      }),
    );
    const warningHandler = vi.fn();
    connectMock.createClient.mockReturnValue({ updateSession });

    const session = await new TenkiSandbox({ authToken: "tk_test", warningHandler }).updateSession("session-1", {});

    expect(session.warnings).toEqual([
      { code: SandboxWarningCodes.MAX_DURATION_CAPPED, message: "max_duration was capped" },
    ]);
    expect(warningHandler).toHaveBeenCalledWith(session.warnings[0]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid update maxDurationMs %p before RPC",
    async (maxDurationMs) => {
      const updateSession = vi.fn();
      connectMock.createClient.mockReturnValue({ updateSession });
      const client = new TenkiSandbox({ authToken: "tk_test" });

      await expect(client.updateSession("session-1", { maxDurationMs })).rejects.toThrow(RangeError);

      expect(updateSession).not.toHaveBeenCalled();
    },
  );

  it("requires sticky with update maxDurationMs before RPC", async () => {
    const updateSession = vi.fn();
    connectMock.createClient.mockReturnValue({ updateSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(client.updateSession("session-1", { maxDurationMs: 60_000 })).rejects.toThrow(
      "sticky must be set when maxDurationMs is provided",
    );

    expect(updateSession).not.toHaveBeenCalled();
  });

  it("returns an updated session when its warning handler throws", async () => {
    const updateSession = vi.fn(async () =>
      create(UpdateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [
          create(SandboxWarningSchema, {
            code: SandboxWarningCode.STICKY_OVERRIDES_IDLE_TIMEOUT,
            message: "sticky overrides idle_timeout",
          }),
        ],
      }),
    );
    const warningHandlerError = new Error("handler failed");
    const warningHandler = vi.fn(() => {
      throw warningHandlerError;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectMock.createClient.mockReturnValue({ updateSession });

    const session = await new TenkiSandbox({ authToken: "tk_test", warningHandler }).updateSession("session-1", {});

    expect(session.warnings).toEqual([
      { code: SandboxWarningCodes.STICKY_OVERRIDES_IDLE_TIMEOUT, message: "sticky overrides idle_timeout" },
    ]);
    expect(error).toHaveBeenCalledWith("tenki sandbox warning handler failed", warningHandlerError);
  });

  it("delivers update warnings from sessions returned by the client", async () => {
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
    const updateSession = vi.fn(async () =>
      create(UpdateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
        warnings: [
          create(SandboxWarningSchema, {
            code: SandboxWarningCode.STICKY_OVERRIDES_IDLE_TIMEOUT,
            message: "sticky overrides idle_timeout",
          }),
        ],
      }),
    );
    const warningHandler = vi.fn();
    connectMock.createClient.mockReturnValue({ createSession, updateSession });
    const client = new TenkiSandbox({ authToken: "tk_test", warningHandler });

    const session = await client.create({ waitReady: false });
    await session.update({ sticky: true });

    expect(session.warnings).toEqual([
      { code: SandboxWarningCodes.STICKY_OVERRIDES_IDLE_TIMEOUT, message: "sticky overrides idle_timeout" },
    ]);
    expect(warningHandler).toHaveBeenCalledWith(session.warnings[0]);
  });

  it("returns a closable session when readiness waiting fails", async () => {
    const sessionProto = () =>
      create(SandboxSessionSchema, {
        id: "session-1",
        state: SessionState.CREATING,
        ownerType: "SERVICE",
        ownerId: "self",
      });
    const rpcClient = {
      createSession: vi.fn(async () => create(CreateSessionResponseSchema, { session: sessionProto() })),
      waitSession: vi.fn(() =>
        (async function* () {
          yield create(WaitSessionResponseSchema, { session: sessionProto() });
        })(),
      ),
      terminateSession: vi.fn(async () =>
        create(TerminateSessionResponseSchema, {
          session: create(SandboxSessionSchema, { id: "session-1", state: SessionState.TERMINATED }),
        }),
      ),
    };
    connectMock.createClient.mockReturnValue(rpcClient);
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const err: unknown = await client.create({ waitTimeoutMs: 50 }).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(WaitReadyFailedError);
    if (!(err instanceof WaitReadyFailedError)) throw err;
    expect(err.session.id).toBe("session-1");
    expect(rpcClient.createSession).toHaveBeenCalledWith(expect.objectContaining({ waitReady: false }));
    await err.session.close();
    expect(rpcClient.terminateSession).toHaveBeenCalledTimes(1);
  });

  it("does not wrap terminal readiness failures", async () => {
    const terminalSession = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.TERMINATED,
      ownerType: "SERVICE",
      ownerId: "self",
      terminalError: "sandbox provisioned but readiness check failed",
    });
    connectMock.createClient.mockReturnValue({
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.CREATING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
      waitSession: vi.fn(() =>
        (async function* () {
          yield create(WaitSessionResponseSchema, { session: terminalSession });
        })(),
      ),
    });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const err: unknown = await client.create().catch((error: unknown) => error);

    expect(err).not.toBeInstanceOf(WaitReadyFailedError);
    expect(err).toHaveProperty("message", expect.stringContaining("sandbox provisioned but readiness check failed"));
  });

  it("preserves template-spec wait defaults when readiness waiting fails", async () => {
    const sessionProto = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.CREATING,
      ownerType: "SERVICE",
      ownerId: "self",
    });
    const waitSession = vi.fn(() =>
      (async function* () {
        yield create(WaitSessionResponseSchema, { session: sessionProto });
      })(),
    );
    connectMock.createClient.mockReturnValue({
      createSession: vi.fn(async () => create(CreateSessionResponseSchema, { session: sessionProto })),
      waitSession,
    });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(client.create({ fromTemplateSpec: "template-1" })).rejects.toThrow(WaitReadyFailedError);

    expect(waitSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 7_200_000 }));
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

  it("omits terminated sessions by default and forwards includeTerminated when requested", async () => {
    const listWorkspaceSandboxes = vi.fn(async () => ({ sessions: [] }));
    connectMock.createClient.mockReturnValue({ listWorkspaceSandboxes });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.list();
    expect(listWorkspaceSandboxes.mock.calls[0][0].includeTerminated).toBe(false);

    await client.list({ includeTerminated: true });
    expect(listWorkspaceSandboxes.mock.calls[1][0].includeTerminated).toBe(true);
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

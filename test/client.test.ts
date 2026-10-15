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
  TailnetEphemeralPausePolicy,
  TailnetExitPolicy,
  TailnetStatusSchema,
  TerminateSessionResponseSchema,
  UpdateSessionResponseSchema,
  WaitSessionResponseSchema,
  type SessionEgressPolicy,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { TailnetAuthKey, tailnetStatusFromProto } from "../src/tailnet.js";
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

  it("accepts apiKey as an alias for authToken", () => {
    expect(new TenkiSandbox({ apiKey: "tk_alias" })).toBeInstanceOf(TenkiSandbox);
    expect(connectMock.createClient).toHaveBeenCalled();
  });

  // Backwards compatibility: apiKey was silently ignored before it became an alias.
  it("prefers authToken when both are supplied", () => {
    expect(new TenkiSandbox({ authToken: "tk_one", apiKey: "tk_two" })).toBeInstanceOf(TenkiSandbox);
    expect(connectMock.createClient).toHaveBeenCalled();
  });

  it("passes root certificates to the default HTTP/2 session manager", () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";

    new TenkiSandbox({ authToken: "tk_test", rootCertificates });

    expect(connectMock.Http2SessionManager).toHaveBeenCalledWith(
      expect.any(String),
      { pingIntervalMs: 30_000, pingTimeoutMs: 5_000 },
      { ca: rootCertificates },
    );
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

    await expect(client.create({ cpuCores: 129 })).rejects.toThrow(InvalidResourceConfigError);
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

  it("warns for the deprecated idleTimeoutMinutes and keeps it off the wire", async () => {
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create({ idleTimeoutMinutes: 15, waitReady: false });

    expect(createSession.mock.calls[0]?.[0].idleTimeoutMinutes).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("idleTimeoutMinutes is deprecated"));
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

  it("sets egress only when allowDomains or allowCidrs is non-empty, and echoes it on the session", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.CREATING,
          ownerType: "SERVICE",
          ownerId: "self",
          egress: { allowDomains: ["*.pypi.org", "files.pythonhosted.org"], allowCidrs: ["10.0.0.0/8"] },
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create({ waitReady: false });
    const session = await client.create({
      allowDomains: ["*.pypi.org", "files.pythonhosted.org"],
      allowCidrs: ["10.0.0.0/8"],
      waitReady: false,
    });

    expect(createSession.mock.calls[0]?.[0].egress).toBeUndefined();
    expect(createSession.mock.calls[1]?.[0].egress?.allowDomains).toEqual(["*.pypi.org", "files.pythonhosted.org"]);
    expect(createSession.mock.calls[1]?.[0].egress?.allowCidrs).toEqual(["10.0.0.0/8"]);
    expect(session.egress).toEqual({
      allowDomains: ["*.pypi.org", "files.pythonhosted.org"],
      allowCidrs: ["10.0.0.0/8"],
      interceptHttps: false,
      allowedPorts: [],
      httpRules: [],
      policyNames: [],
    });
  });

  it("sends HTTPS interception and HTTP rules, and echoes them on the session", async () => {
    const createSession = vi.fn(async (req: { egress?: unknown }) =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.CREATING,
          ownerType: "SERVICE",
          ownerId: "self",
          egress: req.egress as never,
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });
    const httpRules = [
      { domains: ["github.com", "pypi.org"], methods: ["GET", "HEAD"] },
      { domains: ["github.com"], methods: ["POST"], pathRegex: "^/[^/]+/[^/]+(\\.git)?/git-upload-pack$" },
      { domains: ["*"], methods: [], pathPrefix: "/simple/" },
      { domains: ["*.example.com"], methods: [], pathExact: "/exact" },
    ];

    const session = await client.create({
      allowDomains: ["github.com", "pypi.org"],
      interceptHttps: true,
      allowedPorts: [22, 8443],
      httpRules,
      waitReady: false,
    });

    const egress = createSession.mock.calls[0]?.[0].egress as SessionEgressPolicy;
    expect(egress.interceptHttps).toBe(true);
    expect(egress.allowedPorts).toEqual([22, 8443]);
    expect(egress.httpRules.map((rule) => rule.path)).toEqual([
      { case: undefined },
      { case: "regex", value: "^/[^/]+/[^/]+(\\.git)?/git-upload-pack$" },
      { case: "prefix", value: "/simple/" },
      { case: "exact", value: "/exact" },
    ]);
    expect(egress.httpRules[0]?.methods).toEqual(["GET", "HEAD"]);
    expect(session.egress).toEqual({
      allowDomains: ["github.com", "pypi.org"],
      allowCidrs: [],
      interceptHttps: true,
      allowedPorts: [22, 8443],
      httpRules,
      policyNames: [],
    });
  });

  it("sends egress policy names and reads them back with the merged policy", async () => {
    const createSession = vi.fn(async (req: { egressPolicies: string[] }) =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.CREATING,
          ownerType: "SERVICE",
          ownerId: "self",
          egress: { allowDomains: ["github.com", "pypi.org"] },
          egressPolicies: req.egressPolicies,
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const session = await client.create({
      egressPolicies: ["registries", "github-read"],
      allowDomains: ["pypi.org"],
      waitReady: false,
    });

    const request = createSession.mock.calls[0]?.[0] as { egressPolicies: string[]; egress?: SessionEgressPolicy };
    expect(request.egressPolicies).toEqual(["registries", "github-read"]);
    expect(request.egress?.allowDomains).toEqual(["pypi.org"]);
    expect(session.egress).toEqual({
      allowDomains: ["github.com", "pypi.org"],
      allowCidrs: [],
      interceptHttps: false,
      allowedPorts: [],
      httpRules: [],
      policyNames: ["registries", "github-read"],
    });
  });

  it("sends only egress policy names when no inline egress option is set", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, { id: "session-1", state: SessionState.CREATING }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await client.create({ egressPolicies: ["registries"], waitReady: false });

    const request = createSession.mock.calls[0]?.[0] as { egressPolicies: string[]; egress?: unknown };
    expect(request.egressPolicies).toEqual(["registries"]);
    expect(request.egress).toBeUndefined();
    expect(
      toBinary(CreateSessionRequestSchema, create(CreateSessionRequestSchema, { egressPolicies: ["registries"] })),
    ).toEqual(new Uint8Array([0xca, 0x02, 0x0a, ...new TextEncoder().encode("registries")]));
  });

  it("rejects an HTTP rule with more than one path before calling the API", async () => {
    const createSession = vi.fn();
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(
      client.create({
        allowDomains: ["github.com"],
        interceptHttps: true,
        httpRules: [{ domains: ["github.com"], pathExact: "/a", pathPrefix: "/b" }],
        waitReady: false,
      }),
    ).rejects.toThrow("only one of");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("serializes a direct-key tailnet request and maps its status", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.RUNNING,
          tailnetStatus: {
            provider: "tailscale",
            state: "online",
            nodeId: "node-1",
            fqdn: "sandbox.example.ts.net",
            ips: ["100.64.0.1", "fd7a:115c:a1e0::1"],
            tags: ["tag:sandbox"],
            owner: "tag:sandbox",
            deviceRetained: true,
          },
        }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    const session = await client.create({
      waitReady: false,
      tailnet: {
        authKey: new TailnetAuthKey("tskey-auth-secret"),
        hostname: "sandbox-1",
        tags: ["tag:sandbox"],
        ephemeral: true,
        controlUrl: "https://control.example.com",
        exitNode: "auto",
        acceptRoutes: true,
        wakeOnConnect: true,
        exposePorts: [3000, 8080],
        waitForOnline: true,
        exitPolicy: "exit_node_managed",
        ephemeralPausePolicy: "recreate_on_resume",
      },
    });

    const tailnet = createSession.mock.calls[0]?.[0].tailnet;
    if (!tailnet) throw new Error("tailnet request missing");
    const { credential, ...nonSecretTailnet } = tailnet;
    expect(nonSecretTailnet).toEqual(
      expect.objectContaining({
        provider: "tailscale",
        hostname: "sandbox-1",
        tags: ["tag:sandbox"],
        ephemeral: true,
        controlUrl: "https://control.example.com",
        exitNode: "auto",
        acceptRoutes: true,
        wakeOnConnect: true,
        exposePorts: [3000, 8080],
        waitForOnline: true,
        exitPolicy: TailnetExitPolicy.EXIT_NODE_MANAGED,
        ephemeralPausePolicy: TailnetEphemeralPausePolicy.RECREATE_ON_RESUME,
      }),
    );
    expect(credential.case).toBe("authKey");
    if (credential.case !== "authKey") throw new Error("tailnet auth key credential missing");
    expect(credential.value.length).toBe(17);
    expect(session.tailnetStatus).toEqual({
      provider: "tailscale",
      state: "online",
      nodeId: "node-1",
      fqdn: "sandbox.example.ts.net",
      ips: ["100.64.0.1", "fd7a:115c:a1e0::1"],
      tags: ["tag:sandbox"],
      owner: "tag:sandbox",
      error: "",
      deviceRetained: true,
    });
  });

  it("redacts tailnet auth keys from string, JSON, and debug formatting", async () => {
    const { inspect } = await import("node:util");
    const key = new TailnetAuthKey("tskey-auth-secret");

    expect(String(key)).toBe("[REDACTED]");
    expect(JSON.stringify(key)).toBe('"[REDACTED]"');
    expect(inspect(key)).toBe("TailnetAuthKey([REDACTED])");
    expect(`${String(key)} ${JSON.stringify(key)} ${inspect(key)}`).not.toContain("tskey-auth-secret");
  });

  it("defaults legacy tailnet status to tailscale", () => {
    expect(tailnetStatusFromProto(create(TailnetStatusSchema, { state: "joining" }))?.provider).toBe("tailscale");
  });

  it("keeps an unknown response provider", () => {
    expect(tailnetStatusFromProto(create(TailnetStatusSchema, { provider: "future", state: "online" }))?.provider).toBe(
      "future",
    );
  });

  it("inherits workspace tailnet policies when options are omitted", async () => {
    const createSession = vi.fn(async () =>
      create(CreateSessionResponseSchema, {
        session: create(SandboxSessionSchema, { id: "session-1", state: SessionState.RUNNING }),
      }),
    );
    connectMock.createClient.mockReturnValue({ createSession });

    await new TenkiSandbox({ authToken: "tk_test" }).create({
      waitReady: false,
      tailnet: { authKey: new TailnetAuthKey("tskey-auth-secret") },
    });

    expect(createSession.mock.calls[0]?.[0].tailnet?.exitPolicy).toBe(TailnetExitPolicy.UNSPECIFIED);
    expect(createSession.mock.calls[0]?.[0].tailnet?.ephemeralPausePolicy).toBe(
      TailnetEphemeralPausePolicy.UNSPECIFIED,
    );
  });

  it.each(["exitPolicy", "ephemeralPausePolicy", "provider"] as const)(
    "rejects an unknown tailnet %s before sending",
    async (policy) => {
      const createSession = vi.fn();
      connectMock.createClient.mockReturnValue({ createSession });

      await expect(
        new TenkiSandbox({ authToken: "tk_test" }).create({
          waitReady: false,
          tailnet: { authKey: new TailnetAuthKey("tskey-auth-secret"), [policy]: "invalid" } as never,
        }),
      ).rejects.toThrow("unsupported tailnet");
      expect(createSession).not.toHaveBeenCalled();
    },
  );

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

import { execFileSync, spawnSync } from "node:child_process";
import { inspect } from "node:util";
import { create, toJson } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { InvalidStateError, PermissionDeniedError, SandboxError, WaitReadyFailedError } from "../src/errors.js";
import { InjectionCredentialInput, injectionInput, safeInjectionError } from "../src/injection-credentials.js";
import {
  CreateSessionResponseSchema,
  CreateSessionWithInjectionCredentialsRequestSchema,
  CreateSessionWithInjectionCredentialsResponseSchema,
  SessionEgressPolicySchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  RevokeSessionInjectionCredentialRequestSchema,
  RevokeSessionInjectionCredentialResponseSchema,
  SetSessionInjectionCredentialRequestSchema,
  SetSessionInjectionCredentialResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/session_injection_credentials_pb.js";
import { Session } from "../src/session.js";
import { TemplateSpec } from "../src/template-spec.js";

const mock = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@connectrpc/connect", async (original) => ({
  ...(await original<typeof import("@connectrpc/connect")>()),
  createClient: mock.createClient,
}));
const canary = "SYNTHETIC_CANARY_P4_NOT_A_CREDENTIAL";
const input = () =>
  new InjectionCredentialInput("SYNTHETIC", new TextEncoder().encode(canary), [
    { origin: "https://example.invalid", methods: ["GET"], pathPrefix: "/repo", header: "Authorization" },
  ]);
const metadata = { credentialId: "credential-synthetic", name: "SYNTHETIC", revision: 7, revoked: false };
const created = () =>
  create(CreateSessionResponseSchema, { session: { id: "session-synthetic", state: SessionState.RUNNING } });
let rpc: ReturnType<typeof fakeRPC>;
function fakeRPC() {
  return {
    gitOperation: vi.fn(async () => ({ output: "synthetic" })),
    createSession: vi.fn(async () => created()),
    createSessionWithInjectionCredentials: vi.fn(async () =>
      create(CreateSessionWithInjectionCredentialsResponseSchema, { created: created(), credentials: [metadata] }),
    ),
    setSessionInjectionCredential: vi.fn(async () =>
      create(SetSessionInjectionCredentialResponseSchema, { credential: metadata }),
    ),
    revokeSessionInjectionCredential: vi.fn(async () =>
      create(RevokeSessionInjectionCredentialResponseSchema, { credential: { ...metadata, revoked: true } }),
    ),
  };
}
beforeEach(() => {
  vi.restoreAllMocks();
  rpc = fakeRPC();
  mock.createClient.mockReturnValue(rpc);
});

it("preserves ordinary options and credential request shape", async () => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  const options = {
    name: "synthetic",
    env: { EXISTING: "unchanged" },
    githubToken: "SYNTHETIC_GITHUB_CANARY",
    waitReady: false,
  };
  await client.create(options);
  const result = await client.createWithInjectionCredentials([input()], options);
  const request = rpc.createSessionWithInjectionCredentials.mock.calls[0]![0];
  expect(request.session).toEqual(rpc.createSession.mock.calls[0]![0]);
  expect(toJson(CreateSessionWithInjectionCredentialsRequestSchema, request).credentials).toEqual([
    {
      name: "SYNTHETIC",
      value: Buffer.from(canary).toString("base64"),
      rules: [{ origin: "https://example.invalid", methods: ["GET"], pathPrefix: "/repo", header: "Authorization" }],
    },
  ]);
  expect(result.session.id).toBe("session-synthetic");
  expect(result.credentials).toEqual([metadata]);
  expect(result.credentials[0]).not.toHaveProperty("value");
  for (const revision of [undefined, 0, 7]) {
    expect(await result.session.setInjectionCredential(input(), revision)).toEqual(metadata);
    const set = rpc.setSessionInjectionCredential.mock.calls.at(-1)![0];
    expect(set.sessionId).toBe(result.session.id);
    expect(set.credential).toEqual(request.credentials[0]);
    const setJson = toJson(SetSessionInjectionCredentialRequestSchema, set);
    expect(Object.hasOwn(setJson, "expectedRevision")).toBe(revision !== undefined);
    expect(setJson.expectedRevision).toBe(revision);
    expect((await result.session.revokeInjectionCredential("SYNTHETIC", revision)).revoked).toBe(true);
    const revoke = toJson(
      RevokeSessionInjectionCredentialRequestSchema,
      rpc.revokeSessionInjectionCredential.mock.calls.at(-1)![0],
    );
    expect(revoke).toEqual({
      sessionId: result.session.id,
      name: "SYNTHETIC",
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    });
  }
  await client.createWithInjectionCredentials([], options);
  expect(rpc.createSessionWithInjectionCredentials).toHaveBeenCalledTimes(2);
  expect(rpc.createSession).toHaveBeenCalledTimes(1);
});

it.each([
  [Code.PermissionDenied, PermissionDeniedError],
  [Code.FailedPrecondition, InvalidStateError],
  [Code.Aborted, SandboxError],
  [Code.Unimplemented, SandboxError],
])("maps status %s without exposing inputs or remote text", async (code, errorType) => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  const session = await client.create();
  const error = new ConnectError(canary, code);
  rpc.createSessionWithInjectionCredentials.mockRejectedValue(error);
  rpc.setSessionInjectionCredential.mockRejectedValue(error);
  rpc.revokeSessionInjectionCredential.mockRejectedValue(error);
  const secret = input();
  let output =
    String(secret) +
    JSON.stringify(secret) +
    inspect(secret) +
    inspect(secret, { showHidden: true }) +
    inspect({ secret });
  for (const operation of [
    () => client.createWithInjectionCredentials([secret]),
    () => session.setInjectionCredential(secret),
    () => session.revokeInjectionCredential(secret.name),
  ]) {
    try {
      await operation();
      throw new Error("expected RPC failure");
    } catch (err) {
      expect(err).toBeInstanceOf(errorType);
      output += String(err) + inspect(err, { depth: 10 }) + JSON.stringify(err);
    }
  }
  expect(output).not.toContain(canary);
  expect(output).not.toContain(Buffer.from(canary).toString("base64"));
  expect(rpc.createSession).toHaveBeenCalledTimes(1);
});

it("retains cleanup identity after readiness failure", async () => {
  const response = created();
  response.session!.state = SessionState.CREATING;
  rpc.createSessionWithInjectionCredentials.mockResolvedValue(
    create(CreateSessionWithInjectionCredentialsResponseSchema, { created: response, credentials: [metadata] }),
  );
  vi.spyOn(Session.prototype, "waitReady").mockRejectedValue(new Error("synthetic wait failure"));
  const client = new TenkiSandbox({ authToken: "tk_test" });
  try {
    await client.createWithInjectionCredentials([]);
    throw new Error("expected wait failure");
  } catch (err) {
    expect(err).toBeInstanceOf(WaitReadyFailedError);
    expect((err as WaitReadyFailedError).session.id).toBe("session-synthetic");
    expect((err as WaitReadyFailedError).credentials).toEqual([metadata]);
  }
});

it.each([
  [undefined, false],
  [{}, false],
  [{}, true],
])(
  "retains safe runtime admission handling with public egress %s and cleanup failure %s",
  async (publicEgress, cleanupFails) => {
    const cleanupError = new SandboxError("synthetic cleanup failure");
    const terminateSession = vi.fn(async (_request: { sessionId: string }) => {
      if (cleanupFails) throw cleanupError;
      return {};
    });
    mock.createClient.mockReturnValue({ ...rpc, terminateSession });
    const { TemplateRuntimeFailureSchema } = await import("../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js");
    const { TemplateRuntimeFailedError } = await import("../src/errors.js");
    rpc.createSessionWithInjectionCredentials.mockRejectedValue(
      new ConnectError(canary, Code.FailedPrecondition, undefined, [
        {
          desc: TemplateRuntimeFailureSchema,
          value: create(TemplateRuntimeFailureSchema, {
            reason: canary,
            session: { id: "session-synthetic", state: SessionState.RUNNING, metadata: { echo: canary } },
          }),
        },
      ]),
    );
    const client = new TenkiSandbox({ authToken: "tk_test" });
    try {
      await client.createWithInjectionCredentials([input()], { publicEgress });
      throw new Error("expected runtime failure");
    } catch (error) {
      const cause = (error as Error).cause;
      const runtime = (
        publicEgress === undefined ? error : (error as InstanceType<typeof TemplateRuntimeFailedError>).runtimeFailure
      ) as InstanceType<typeof TemplateRuntimeFailedError>;
      if (publicEgress === undefined) {
        expect(error).toBeInstanceOf(TemplateRuntimeFailedError);
        expect((error as InstanceType<typeof TemplateRuntimeFailedError>).session.id).toBe("session-synthetic");
        expect(terminateSession).not.toHaveBeenCalled();
      } else {
        expect((error as Error).constructor).toBe(Error);
        expect(error).toHaveProperty("credentials", []);
        expect(cause).toBe(cleanupFails ? cleanupError : runtime);
        expect(runtime).toBeInstanceOf(TemplateRuntimeFailedError);
        expect(runtime).toHaveProperty("session.id", "session-synthetic");
        expect(runtime).toHaveProperty("credentials", []);
        expect((error as Error).message).toBe(
          cleanupFails
            ? "Server does not support public egress restrictions; session cleanup failed"
            : "Server does not support public egress restrictions",
        );
        expect(terminateSession).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionId: "session-synthetic" }),
        );
      }
      expect(runtime.session.metadata).toEqual({});
      expect(inspect({ message: runtime.message, cause: runtime.cause }, { depth: 10 })).not.toContain(canary);
      expect(String(error)).not.toContain(canary);
    }
  },
);

it.each([-1, 1.5, 0x100000000, NaN])("rejects invalid revision %s before transport", async (revision) => {
  const session = await new TenkiSandbox({ authToken: "tk_test" }).create();
  await expect(session.setInjectionCredential(input(), revision)).rejects.toThrow(TypeError);
  await expect(session.revokeInjectionCredential("SYNTHETIC", revision)).rejects.toThrow(TypeError);
  expect(rpc.setSessionInjectionCredential).not.toHaveBeenCalled();
  expect(rpc.revokeSessionInjectionCredential).not.toHaveBeenCalled();
});

it("keeps GitHub defaults byte identical and opts into two credentials", async () => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  const options = { githubToken: canary, waitReady: false };
  await client.create(options);
  const golden = rpc.createSession.mock.calls[0]![0];
  expect(golden.env).toEqual({ GH_TOKEN: canary, GIT_TOKEN: canary });
  await client.create({ ...options, githubTokenInjection: false });
  expect(rpc.createSession.mock.calls[1]![0]).toEqual(golden);
  const session = await client.create({ ...options, githubTokenInjection: true });
  const req = rpc.createSessionWithInjectionCredentials.mock.calls[0]![0];
  expect(req.session.env.GH_TOKEN).toBe("secrets://SDK_GITHUB_API");
  expect(req.session.env.GIT_TOKEN).toBe("secrets://SDK_GITHUB_API");
  expect(JSON.stringify(req.session)).not.toContain(canary);
  expect(req.credentials.map((c) => c.name)).toEqual(["SDK_GITHUB_API", "SDK_GITHUB_GIT"]);
  expect(Buffer.from(req.credentials[0].value).toString()).toBe(canary);
  expect(Buffer.from(req.credentials[1].value).toString()).toBe(
    Buffer.from("x-access-token:" + canary).toString("base64"),
  );
  expect(toJson(CreateSessionWithInjectionCredentialsRequestSchema, req).credentials[1].rules).toEqual([
    { origin: "https://github.com", methods: ["GET", "POST"], pathPrefix: "/", header: "Authorization" },
  ]);
  expect(req.session.env.GIT_CONFIG_VALUE_0).toBe("Authorization: Basic secrets://SDK_GITHUB_GIT");
  expect(req.session.env.GIT_CONFIG_VALUE_1).toBe("HTTP/1.1");
  expect(req.session.env.GIT_CONFIG_VALUE_2).toBe("");
  await client.createWithInjectionCredentials([], { ...options, githubTokenInjection: true });
  expect(rpc.createSessionWithInjectionCredentials.mock.calls[1]![0]).toEqual(req);
  await session.rotateGitHubToken("SYNTHETIC_ROTATED_CANARY");
  expect(rpc.setSessionInjectionCredential.mock.calls.map(([r]) => r.credential.name)).toEqual([
    "SDK_GITHUB_API",
    "SDK_GITHUB_GIT",
  ]);
  expect(Buffer.from(rpc.setSessionInjectionCredential.mock.calls[1][0].credential.value).toString()).toBe(
    Buffer.from("x-access-token:SYNTHETIC_ROTATED_CANARY").toString("base64"),
  );
  rpc.setSessionInjectionCredential.mockRejectedValueOnce(new ConnectError(canary, Code.FailedPrecondition));
  await expect(session.rotateGitHubToken(canary)).rejects.toBeInstanceOf(InvalidStateError);
  expect(rpc.setSessionInjectionCredential).toHaveBeenCalledTimes(3);
});

it.each([Code.Unimplemented, Code.FailedPrecondition, Code.PermissionDenied])(
  "passes GitHub injection refusal %s through without fallback",
  async (code) => {
    rpc.createSessionWithInjectionCredentials.mockRejectedValue(new ConnectError(canary, code));
    await expect(
      new TenkiSandbox({ authToken: "tk_test" }).create({ githubToken: canary, githubTokenInjection: true }),
    ).rejects.toBeInstanceOf(SandboxError);
    expect(rpc.createSession).not.toHaveBeenCalled();
  },
);

it.each([
  {},
  { githubToken: " " },
  { githubToken: canary, env: { GH_HOST: "enterprise.invalid" } },
  { githubToken: canary, env: { GIT_CONFIG_COUNT: "1" } },
  { githubToken: canary, cloneRepoUrl: "https://github.com/synthetic/repo" },
])("rejects unsupported injection options before transport", async (options) => {
  await expect(
    new TenkiSandbox({ authToken: "tk_test" }).create({ ...options, githubTokenInjection: true }),
  ).rejects.toThrow();
  expect(rpc.createSession).not.toHaveBeenCalled();
  expect(rpc.createSessionWithInjectionCredentials).not.toHaveBeenCalled();
});

it("keeps all Git helper calls secret-free and applies URL-scoped config", async () => {
  const session = await new TenkiSandbox({ authToken: "tk_test" }).create({
    githubToken: canary,
    githubTokenInjection: true,
  });
  const exec = vi.spyOn(session, "exec").mockResolvedValue({
    status: "SUCCEEDED",
    exitCode: 0,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
  } as never);
  await session.git.clone("https://github.com/synthetic/repo.git");
  await session.git.checkout("main");
  await session.git.diff();
  await session.git.log();
  await session.git.fetchPR(1);
  await session.exec("git", { args: ["fetch", "origin"] });
  await session.exec("git", { args: ["push", "origin"] });
  expect(rpc.gitOperation).toHaveBeenCalledTimes(4);
  expect(exec).toHaveBeenCalledTimes(4);
  const env = rpc.createSessionWithInjectionCredentials.mock.calls[0][0].session.env;
  const wire = JSON.stringify([rpc.gitOperation.mock.calls, exec.mock.calls, env]);
  expect(wire).not.toContain(canary);
  expect(wire).not.toContain(Buffer.from("x-access-token:" + canary).toString("base64"));
  for (const [key, value] of [
    ["http.extraHeader", "Authorization: Basic secrets://SDK_GITHUB_GIT"],
    ["http.version", "HTTP/1.1"],
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
  ]) {
    expect(
      execFileSync("git", ["config", "--get-urlmatch", key!, "https://github.com/synthetic/repo.git"], {
        env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        encoding: "utf8",
      }).trim(),
    ).toBe(value);
  }
});

it("does not authorize non-default Git origins", async () => {
  await new TenkiSandbox({ authToken: "tk_test" }).create({ githubToken: canary, githubTokenInjection: true });
  const env = rpc.createSessionWithInjectionCredentials.mock.calls[0][0].session.env;
  for (const url of [
    "https://enterprise.invalid/repo",
    "http://github.com/repo",
    "https://github.com.attacker.invalid/repo",
  ]) {
    const result = spawnSync("git", ["config", "--get-urlmatch", "http.extraHeader", url], {
      env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  }
});

it.each([1, 2])("identifies rotation failure at credential %s and allows retrying both", async (failAt) => {
  const session = await new TenkiSandbox({ authToken: "tk_test" }).create({
    githubToken: canary,
    githubTokenInjection: true,
  });
  if (failAt === 2)
    rpc.setSessionInjectionCredential.mockResolvedValueOnce(
      create(SetSessionInjectionCredentialResponseSchema, { credential: metadata }),
    );
  rpc.setSessionInjectionCredential.mockRejectedValueOnce(new ConnectError(canary, Code.FailedPrecondition));
  const failure = await session.rotateGitHubToken(canary).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(InvalidStateError);
  expect((failure as Error).message).toMatch(
    failAt === 1
      ? /^rotate SDK_GITHUB_API failed:/
      : /^rotate SDK_GITHUB_GIT failed \(SDK_GITHUB_API already rotated\):/,
  );
  expect(inspect(failure)).not.toContain(canary);
  expect(rpc.setSessionInjectionCredential).toHaveBeenCalledTimes(failAt);
  await session.rotateGitHubToken(canary);
  expect(rpc.setSessionInjectionCredential.mock.calls.slice(failAt).map(([r]) => r.credential.name)).toEqual([
    "SDK_GITHUB_API",
    "SDK_GITHUB_GIT",
  ]);
});

it.each([undefined, false, true, "udp"] as const)(
  "preserves tailnet option %s and compatibility cleanup for credential create",
  async (setting) => {
    const { TailnetPortProtocol } = await import("../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js");
    for (const waitReady of [false, true]) {
      for (const acknowledged of [false, true]) {
        const acceptDns = typeof setting === "boolean" ? setting : undefined;
        const exposedPorts = setting === "udp" ? [{ port: 6081, protocol: "udp" as const }] : [];
        const response = created();
        if (acknowledged) {
          const { TailnetStatusSchema } = await import("../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js");
          response.session!.tailnetStatus = create(TailnetStatusSchema, {
            acceptDns,
            exposedPorts: exposedPorts.map(({ port }) => ({ port, protocol: TailnetPortProtocol.UDP })),
          });
        }
        rpc = fakeRPC();
        const terminateSession = vi.fn(async (_request: { sessionId: string }) => ({}));
        mock.createClient.mockReturnValue({ ...rpc, terminateSession });
        rpc.createSession.mockResolvedValue(response);
        rpc.createSessionWithInjectionCredentials.mockResolvedValue(
          create(CreateSessionWithInjectionCredentialsResponseSchema, { created: response }),
        );
        const client = new TenkiSandbox({ authToken: "tk_test" });
        const options = {
          waitReady,
          tailnet: { profileId: "11111111-1111-4111-8111-111111111111", acceptDns, exposedPorts },
        };
        for (const operation of [
          () => client.create(options),
          () => client.createWithInjectionCredentials([], options),
        ]) {
          if (!acknowledged && setting !== undefined) {
            await expect(operation()).rejects.toThrow(/acknowledge|does not support/);
          } else {
            await operation();
          }
        }
        const request = rpc.createSessionWithInjectionCredentials.mock.calls[0]![0].session!;
        expect(request).toEqual(rpc.createSession.mock.calls[0]![0]);
        expect(request.tailnet?.acceptDns).toBe(acceptDns);
        expect(request.tailnet?.exposedPorts.map(({ port, protocol }) => ({ port, protocol }))).toEqual(
          exposedPorts.map(({ port }) => ({ port, protocol: TailnetPortProtocol.UDP })),
        );
        expect(terminateSession).toHaveBeenCalledTimes(!acknowledged && setting !== undefined ? 2 : 0);
        for (const [request] of terminateSession.mock.calls) expect(request.sessionId).toBe("session-synthetic");
      }
    }
  },
);

it.each([
  ["omitted", undefined, undefined, false],
  ["deny_all", {}, {}, false],
  ["narrowed", { tcpPorts: [80, 443] }, { tcpPorts: [443] }, false],
  ["missing", {}, undefined, true],
  ["wider", { tcpPorts: [443] }, { tcpPorts: [22] }, true],
] as const)(
  "preserves public egress %s for ordinary and credential create",
  async (_name, requested, accepted, rejected) => {
    for (const waitReady of [false, true]) {
      rpc = fakeRPC();
      const response = created();
      response.session!.egress = create(SessionEgressPolicySchema, { publicEgress: accepted });
      rpc.createSession.mockResolvedValue(response);
      rpc.createSessionWithInjectionCredentials.mockResolvedValue(
        create(CreateSessionWithInjectionCredentialsResponseSchema, { created: response }),
      );
      const createSessionWithPublicEgress = vi.fn(async (_request: { request?: unknown }) => ({ response }));
      const terminateSession = vi.fn(async (_request: { sessionId: string }) => ({}));
      mock.createClient.mockReturnValue({ ...rpc, createSessionWithPublicEgress, terminateSession });
      const client = new TenkiSandbox({ authToken: "tk_test" });
      const options = { waitReady, publicEgress: requested };
      for (const operation of [
        () => client.create(options),
        () => client.createWithInjectionCredentials([input()], options),
      ]) {
        if (rejected) await expect(operation()).rejects.toThrow("does not support public egress");
        else await operation();
      }
      expect(rpc.createSession).toHaveBeenCalledTimes(requested === undefined ? 1 : 0);
      expect(createSessionWithPublicEgress).toHaveBeenCalledTimes(requested === undefined ? 0 : 1);
      expect(rpc.createSessionWithInjectionCredentials).toHaveBeenCalledTimes(1);
      const ordinary =
        requested === undefined
          ? rpc.createSession.mock.calls[0]![0]
          : createSessionWithPublicEgress.mock.calls[0]![0].request;
      expect(rpc.createSessionWithInjectionCredentials.mock.calls[0]![0].session).toEqual(ordinary);
      expect(terminateSession).toHaveBeenCalledTimes(rejected ? 2 : 0);
      for (const [request] of terminateSession.mock.calls) expect(request.sessionId).toBe("session-synthetic");
    }
  },
);

it.each(["GH_TOKEN", "GIT_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"])(
  "rejects GitHub injection secret target conflict: %s",
  async (target) => {
    await expect(
      new TenkiSandbox({ authToken: "tk_test" }).create({
        githubToken: canary,
        githubTokenInjection: true,
        directRuntime: new TemplateSpec().start("app", { secretEnv: { [target]: "token" } }),
      }),
    ).rejects.toThrow("secret target conflicts with session environment");
    expect(rpc.createSession).not.toHaveBeenCalled();
    expect(rpc.createSessionWithInjectionCredentials).not.toHaveBeenCalled();
  },
);

it("rejects malformed credential inputs before calling the transport", async () => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  await expect(client.createWithInjectionCredentials([{} as InjectionCredentialInput])).rejects.toThrow(TypeError);
  expect(rpc.createSessionWithInjectionCredentials).not.toHaveBeenCalled();
});

it.each([
  [Code.NotFound, "template not found", "TemplateNotFoundError"],
  [Code.NotFound, "egress policy not found", "EgressPolicyNotFoundError"],
  [Code.FailedPrecondition, "session terminated", "SessionTerminatedError"],
  [Code.ResourceExhausted, "rate limit", "RateLimitedError"],
  [Code.ResourceExhausted, "capacity unavailable", "CapacityUnavailableError"],
] as const)("preserves typed classification for %s %s", async (code, message, expected) => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  const session = await client.create();
  const failure = new ConnectError(`${message}: ${canary}`, code);
  rpc.createSessionWithInjectionCredentials.mockRejectedValue(failure);
  rpc.setSessionInjectionCredential.mockRejectedValue(failure);
  rpc.revokeSessionInjectionCredential.mockRejectedValue(failure);
  for (const operation of [
    () => client.createWithInjectionCredentials([input()]),
    () => session.setInjectionCredential(input()),
    () => session.revokeInjectionCredential("SYNTHETIC"),
  ]) {
    const error = await operation().catch((error: Error) => error);
    expect(error).toHaveProperty("name", expected);
    expect(inspect(error, { depth: 10 }) + JSON.stringify(error)).not.toContain(canary);
  }
});

it("preserves sanitized runtime identity for credential mutations", async () => {
  const { TemplateRuntimeFailureSchema } = await import("../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js");
  const { TemplateRuntimeFailedError } = await import("../src/errors.js");
  const session = await new TenkiSandbox({ authToken: "tk_test" }).create();
  const failure = new ConnectError(canary, Code.FailedPrecondition, undefined, [
    {
      desc: TemplateRuntimeFailureSchema,
      value: create(TemplateRuntimeFailureSchema, {
        reason: canary,
        session: { id: session.id, state: SessionState.RUNNING, metadata: { echo: canary } },
      }),
    },
  ]);
  rpc.setSessionInjectionCredential.mockRejectedValue(failure);
  rpc.revokeSessionInjectionCredential.mockRejectedValue(failure);
  for (const operation of [
    () => session.setInjectionCredential(input()),
    () => session.revokeInjectionCredential("SYNTHETIC"),
  ]) {
    const error = await operation().catch((error: Error) => error);
    expect(error).toBeInstanceOf(TemplateRuntimeFailedError);
    const runtime = error as InstanceType<typeof TemplateRuntimeFailedError>;
    expect(runtime.session.id).toBe(session.id);
    expect(runtime.session.metadata).toEqual({});
    expect(inspect({ message: runtime.message, cause: runtime.cause }, { depth: 10 })).not.toContain(canary);
  }
});

it("copies Buffer bytes and deeply freezes captured rules", () => {
  const bytes = Buffer.from(canary);
  const rules = [{ origin: "https://example.invalid", methods: ["GET"], pathPrefix: "/repo", header: "Authorization" }];
  const credential = new InjectionCredentialInput("SYNTHETIC", bytes, rules);
  bytes.fill(0);
  rules[0].origin = "https://changed.invalid";
  rules[0].methods.push("POST");
  rules.push({ ...rules[0] });
  expect(() => credential.rules.push(rules[0])).toThrow(TypeError);
  expect(() => {
    credential.rules[0].origin = "https://changed.invalid";
  }).toThrow(TypeError);
  expect(() => credential.rules[0].methods.push("POST")).toThrow(TypeError);
  const wire = injectionInput(credential);
  expect(Buffer.from(wire.value).toString()).toBe(canary);
  expect(wire.rules).toEqual([expect.objectContaining({ origin: "https://example.invalid", methods: ["GET"] })]);
  wire.value.fill(0);
  wire.rules[0].methods.push("POST");
  expect(Buffer.from(injectionInput(credential).value).toString()).toBe(canary);
  expect(injectionInput(credential).rules[0].methods).toEqual(["GET"]);
});

it.each([
  ["AbortError", false],
  ["AbortError", true],
  ["TimeoutError", false],
  ["TimeoutError", true],
] as const)("preserves local %s (wrapped=%s) without remote text", async (name, wrapped) => {
  const client = new TenkiSandbox({ authToken: "tk_test" });
  const session = await client.create();
  const local = new DOMException(canary, name);
  const error = wrapped ? ConnectError.from(local) : local;
  rpc.createSessionWithInjectionCredentials.mockRejectedValue(error);
  rpc.setSessionInjectionCredential.mockRejectedValue(error);
  rpc.revokeSessionInjectionCredential.mockRejectedValue(error);
  for (const operation of [
    () => client.createWithInjectionCredentials([input()]),
    () => session.setInjectionCredential(input()),
    () => session.revokeInjectionCredential("SYNTHETIC"),
  ]) {
    if (wrapped) {
      await expect(operation()).rejects.toMatchObject({ cause: { code: Code.Canceled } });
    } else {
      await expect(operation()).rejects.toMatchObject({ name });
    }
    await expect(operation()).rejects.not.toThrow(canary);
  }
});

it("retains runtime failure and acknowledged public egress", async () => {
  const terminateSession = vi.fn(async () => ({}));
  mock.createClient.mockReturnValue({ ...rpc, terminateSession });
  const { TemplateRuntimeFailureSchema } = await import("../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js");
  const { TemplateRuntimeFailedError } = await import("../src/errors.js");
  rpc.createSessionWithInjectionCredentials.mockRejectedValue(
    new ConnectError(canary, Code.FailedPrecondition, undefined, [
      {
        desc: TemplateRuntimeFailureSchema,
        value: create(TemplateRuntimeFailureSchema, {
          reason: canary,
          session: {
            id: "session-synthetic",
            state: SessionState.RUNNING,
            egress: { publicEgress: { tcpPorts: [443] } },
            metadata: { echo: canary },
          },
        }),
      },
    ]),
  );
  const client = new TenkiSandbox({ authToken: "tk_test" });
  try {
    await client.createWithInjectionCredentials([input()], { publicEgress: { tcpPorts: [443] } });
    throw new Error("expected runtime failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateRuntimeFailedError);
    expect((error as InstanceType<typeof TemplateRuntimeFailedError>).credentials).toEqual([]);
    expect(inspect({ message: (error as Error).message, cause: (error as Error).cause }, { depth: 10 })).not.toContain(
      canary,
    );
    expect((error as InstanceType<typeof TemplateRuntimeFailedError>).session.metadata).toEqual({});
  }
  expect(terminateSession).not.toHaveBeenCalled();
});

it.each([false, true])("retains metadata after egress rejection with cleanup failure %s", async (cleanupFails) => {
  const terminateSession = vi.fn(async () => {
    if (cleanupFails) throw new Error("synthetic cleanup failure");
    return {};
  });
  mock.createClient.mockReturnValue({ ...rpc, terminateSession });
  const error = await new TenkiSandbox({ authToken: "tk_test" })
    .createWithInjectionCredentials([input()], { publicEgress: {} })
    .catch((err) => err);
  expect(error.constructor).toBe(Error);
  expect(error.message).toContain("does not support public egress");
  expect(error.credentials).toEqual([metadata]);
  if (cleanupFails) expect(error.cause.message).toContain("synthetic cleanup failure");
  expect(terminateSession).toHaveBeenCalledOnce();
});

it("preserves the capability primitive while redacting git stderr and remote text", async () => {
  const { CapabilityUnavailableError, GitOperationFailedError } = await import("../src/errors.js");
  const capability = safeInjectionError(
    new ConnectError(`unknown request type: *sandboxv1.GuestRequest_Stat ${canary}`, Code.Unimplemented),
  );
  expect(capability).toBeInstanceOf(CapabilityUnavailableError);
  expect((capability as InstanceType<typeof CapabilityUnavailableError>).primitive).toBe("Stat");
  const git = safeInjectionError(
    new ConnectError(
      `git clone failed (exit_code=128); check the repository, ref and access token: ${canary}`,
      Code.FailedPrecondition,
    ),
  );
  expect(git).toBeInstanceOf(GitOperationFailedError);
  expect((git as InstanceType<typeof GitOperationFailedError>).stderr).toBe("");
  expect((git as InstanceType<typeof GitOperationFailedError>).exitCode).toBe(128);
  expect(inspect({ capability, git }, { depth: 10 })).not.toContain(canary);
});

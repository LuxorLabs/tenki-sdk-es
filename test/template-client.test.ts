import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { InvalidTemplateSpecError, TemplateBuildFailedError } from "../src/errors.js";
import { RegistryImageSchema } from "../src/internal/proto/tenki/sandbox/v1/registry_pb.js";
import {
  CreateSessionResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  BuildTemplateResponseSchema,
  CancelTemplateBuildResponseSchema,
  CreateTemplateResponseSchema,
  GetTemplateBuildResponseSchema,
  ListActiveTemplateBuildsResponseSchema,
  TemplateBuildEventSchema,
  TemplateBuildSchema,
  TemplateBuildState,
  TemplateDefinitionMode,
  TemplateSchema,
  UpdateTemplateResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";
import { TemplateSpec } from "../src/template-spec.js";
import type { Template, TemplateBuild, TemplateBuildEvent } from "../src/template.js";

const connectMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(() => ({ kind: "transport" })),
}));

vi.mock("@connectrpc/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@connectrpc/connect")>();
  return { ...actual, createClient: connectMock.createClient };
});

vi.mock("@connectrpc/connect-node", () => ({
  createGrpcTransport: connectMock.createGrpcTransport,
}));

function makeSdk(rpcClient: object): TenkiSandbox {
  connectMock.createClient.mockReturnValue(rpcClient);
  return new TenkiSandbox({ authToken: "tk_test", transport: {} as never });
}

function logEvent(data: string) {
  return create(TemplateBuildEventSchema, {
    event: { case: "log", value: { phase: "steps", data } },
  });
}

function buildProto(state: TemplateBuildState, events: ReturnType<typeof logEvent>[] = []) {
  return create(TemplateBuildSchema, { id: "build-1", templateId: "template-1", state, events });
}

describe("TenkiSandbox template APIs", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards template build environment and secrets", async () => {
    const rpcClient = {
      buildTemplate: vi.fn(async () =>
        create(BuildTemplateResponseSchema, { build: buildProto(TemplateBuildState.PENDING) }),
      ),
    };
    const sdk = makeSdk(rpcClient);
    const env = { NODE_ENV: "production" };
    const secrets = { GIT_TOKEN: "token", NPM_TOKEN: "npm" };

    await sdk.buildTemplate(" template-1 ", { buildEnv: env, buildSecrets: secrets });
    env.NODE_ENV = "mutated";
    secrets.GIT_TOKEN = "mutated";

    expect(rpcClient.buildTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "template-1",
        buildEnv: { NODE_ENV: "production" },
        buildSecrets: { GIT_TOKEN: "token", NPM_TOKEN: "npm" },
      }),
    );
  });

  it("creates a template from a typed spec", async () => {
    const rpcClient = {
      createTemplate: vi.fn(async () =>
        create(CreateTemplateResponseSchema, {
          template: create(TemplateSchema, {
            id: "template-1",
            name: "node-api",
            definitionMode: TemplateDefinitionMode.TYPED,
            specHash: "sha256:" + "a".repeat(64),
            builderSpec: new TemplateSpec().toProto(),
          }),
        }),
      ),
    };
    const spec = new TemplateSpec()
      .fromImage("sandbox-v2")
      .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
      .run("npm ci");

    const template = await makeSdk(rpcClient).createTemplate({
      workspaceId: "workspace-1",
      name: "node-api",
      spec,
    });

    const request = rpcClient.createTemplate.mock.calls[0]?.[0];
    expect(request.builderSpec?.specVersion).toBe("tenki.template.v1");
    expect(request.builderSpec?.base?.source).toEqual({ case: "image", value: "sandbox-v2" });
    expect(request.builderSpec?.steps).toHaveLength(1);
    expect(template.spec).toBeInstanceOf(TemplateSpec);
    expect(template.specHash).toBe("sha256:" + "a".repeat(64));
    expect(template.definitionMode).toBe("TYPED");
  });

  it("rejects typed specs combined with legacy fields", async () => {
    const sdk = makeSdk({});
    await expect(
      sdk.createTemplate({
        workspaceId: "workspace-1",
        name: "node-api",
        spec: new TemplateSpec(),
        setupScript: "npm ci",
        env: { NODE_ENV: "production" },
      }),
    ).rejects.toThrow(InvalidTemplateSpecError);

    await expect(sdk.updateTemplate("template-1", { spec: new TemplateSpec(), startCmd: "npm start" })).rejects.toThrow(
      InvalidTemplateSpecError,
    );
  });

  it("rejects locally invalid typed specs before RPC submission", async () => {
    const rpcClient = { createTemplate: vi.fn(), updateTemplate: vi.fn() };
    const sdk = makeSdk(rpcClient);
    const invalid = new TemplateSpec().resources({ cpuCores: 17 });

    await expect(sdk.createTemplate({ workspaceId: "workspace-1", name: "node-api", spec: invalid })).rejects.toThrow(
      InvalidTemplateSpecError,
    );
    await expect(sdk.updateTemplate("template-1", { spec: invalid })).rejects.toThrow(InvalidTemplateSpecError);
    expect(rpcClient.createTemplate).not.toHaveBeenCalled();
    expect(rpcClient.updateTemplate).not.toHaveBeenCalled();
  });

  it("replaces the typed spec atomically on update and accepts template objects", async () => {
    const rpcClient = {
      updateTemplate: vi.fn(async () =>
        create(UpdateTemplateResponseSchema, { template: create(TemplateSchema, { id: "template-1" }) }),
      ),
    };
    const spec = new TemplateSpec().run("npm ci");

    await makeSdk(rpcClient).updateTemplate({ id: "template-1" } as Template, { spec });

    const request = rpcClient.updateTemplate.mock.calls[0]?.[0];
    expect(request.templateId).toBe("template-1");
    expect(request.builderSpec?.steps).toHaveLength(1);
  });

  it("builds from a template object and cancels from a build object", async () => {
    const rpcClient = {
      buildTemplate: vi.fn(async () =>
        create(BuildTemplateResponseSchema, { build: buildProto(TemplateBuildState.PENDING) }),
      ),
      cancelTemplateBuild: vi.fn(async () =>
        create(CancelTemplateBuildResponseSchema, { build: buildProto(TemplateBuildState.FAILED) }),
      ),
    };
    const sdk = makeSdk(rpcClient);

    const build = await sdk.buildTemplate({ id: "template-1" } as Template);
    const cancelled = await sdk.cancelTemplateBuild(build);

    expect(rpcClient.buildTemplate).toHaveBeenCalledWith(expect.objectContaining({ templateId: "template-1" }));
    expect(rpcClient.cancelTemplateBuild).toHaveBeenCalledWith(expect.objectContaining({ buildId: "build-1" }));
    expect(cancelled.state).toBe("FAILED");
  });

  it("lists active template builds from a template object", async () => {
    const rpcClient = {
      listActiveTemplateBuilds: vi.fn(async () =>
        create(ListActiveTemplateBuildsResponseSchema, {
          builds: [buildProto(TemplateBuildState.BUILDING), buildProto(TemplateBuildState.PENDING)],
        }),
      ),
    };
    const builds = await makeSdk(rpcClient).listActiveTemplateBuilds({
      id: "template-1",
    } as Template);

    expect(rpcClient.listActiveTemplateBuilds).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: "template-1" }),
    );
    expect(builds.map((build) => build.state)).toEqual(["BUILDING", "PENDING"]);
  });

  it("delivers ordered deduplicated events and awaits async handlers sequentially", async () => {
    const responses = [
      buildProto(TemplateBuildState.BUILDING, [logEvent("one")]),
      buildProto(TemplateBuildState.BUILDING, [logEvent("one"), logEvent("two")]),
      buildProto(TemplateBuildState.READY, [logEvent("one"), logEvent("two"), logEvent("three")]),
    ];
    const rpcClient = {
      getTemplateBuild: vi.fn(async () => create(GetTemplateBuildResponseSchema, { build: responses.shift()! })),
    };
    const seen: string[] = [];
    const onEvent = async (event: TemplateBuildEvent) => {
      seen.push(`start:${event.type === "log" ? event.data : ""}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(`end:${event.type === "log" ? event.data : ""}`);
    };

    const done = await makeSdk(rpcClient).waitForTemplateBuild("build-1", { onEvent });

    expect(done.state).toBe("READY");
    expect(seen).toEqual(["start:one", "end:one", "start:two", "end:two", "start:three", "end:three"]);
  });

  it("propagates handler failures unchanged and never cancels the remote build", async () => {
    class HandlerError extends Error {}
    const rpcClient = {
      buildTemplate: vi.fn(async () =>
        create(BuildTemplateResponseSchema, { build: buildProto(TemplateBuildState.PENDING) }),
      ),
      getTemplateBuild: vi.fn(async () =>
        create(GetTemplateBuildResponseSchema, {
          build: buildProto(TemplateBuildState.BUILDING, [logEvent("one")]),
        }),
      ),
      cancelTemplateBuild: vi.fn(),
    };

    const err = await makeSdk(rpcClient)
      .buildTemplate("template-1", {
        waitForCompletion: true,
        onEvent: () => {
          throw new HandlerError("observer exploded");
        },
      })
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(HandlerError);
    expect(rpcClient.cancelTemplateBuild).not.toHaveBeenCalled();
  });

  it("stops observation with the abort reason without cancelling remotely", async () => {
    const controller = new AbortController();
    const rpcClient = {
      getTemplateBuild: vi.fn(async () => {
        controller.abort(new Error("observer went away"));
        return create(GetTemplateBuildResponseSchema, { build: buildProto(TemplateBuildState.BUILDING) });
      }),
      cancelTemplateBuild: vi.fn(),
    };

    const err = await makeSdk(rpcClient)
      .waitForTemplateBuild("build-1", { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(err).toMatchObject({ message: "observer went away" });
    expect(rpcClient.cancelTemplateBuild).not.toHaveBeenCalled();
  });

  it("throws TemplateBuildFailedError carrying the final build", async () => {
    const failed = create(TemplateBuildSchema, {
      id: "build-1",
      templateId: "template-1",
      state: TemplateBuildState.FAILED,
      failure: { code: "STEP_FAILED", message: "npm ci exited 1" },
    });
    const rpcClient = {
      getTemplateBuild: vi.fn(async () => create(GetTemplateBuildResponseSchema, { build: failed })),
    };

    const err = await makeSdk(rpcClient)
      .waitForTemplateBuild("build-1")
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(TemplateBuildFailedError);
    expect((err as TemplateBuildFailedError).message).toBe("npm ci exited 1");
    expect((err as TemplateBuildFailedError).build).toMatchObject({
      id: "build-1",
      state: "FAILED",
      failure: { code: "STEP_FAILED" },
    });
  });

  it("exposes the frozen spec, spec hash, and digest-addressed image on waited builds", async () => {
    const ready = create(TemplateBuildSchema, {
      id: "build-1",
      templateId: "template-1",
      state: TemplateBuildState.READY,
      builderSpec: new TemplateSpec().fromImage("sandbox").toProto(),
      specHash: "sha256:" + "b".repeat(64),
      image: create(RegistryImageSchema, { id: "image-1", workspaceSlug: "acme", name: "node-api" }),
      imageDigest: "sha256:" + "c".repeat(64),
      imageDigestRef: "acme/node-api@sha256:" + "c".repeat(64),
    });
    const rpcClient = {
      getTemplateBuild: vi.fn(async () => create(GetTemplateBuildResponseSchema, { build: ready })),
    };

    const build = await makeSdk(rpcClient).waitForTemplateBuild("build-1");

    expect(build.spec).toBeInstanceOf(TemplateSpec);
    expect(build.specHash).toBe("sha256:" + "b".repeat(64));
    expect(build.image).toMatchObject({
      ref: "acme/node-api",
      digest: "sha256:" + "c".repeat(64),
      digestRef: "acme/node-api@sha256:" + "c".repeat(64),
    });
    expect(build.imageDigestRef).toBe("acme/node-api@sha256:" + "c".repeat(64));
  });

  it("creates sandboxes from a build image object, pinning the digest ref", async () => {
    const rpcClient = {
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.RUNNING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
    };
    const image = {
      ref: "acme/node-api",
      digestRef: "acme/node-api@sha256:" + "c".repeat(64),
    };

    await makeSdk(rpcClient).create({ image, waitForRuntime: true });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.registryRef).toBe("acme/node-api@sha256:" + "c".repeat(64));
    expect(request.waitForRuntime).toBe(true);

    await makeSdk(rpcClient).create({ image: { ref: "acme/node-api" } });
    expect(rpcClient.createSession.mock.calls[1]?.[0].registryRef).toBe("acme/node-api");
  });

  it("reconnects to an existing build without re-dropping prior events", async () => {
    const responses = [
      buildProto(TemplateBuildState.BUILDING, [logEvent("one"), logEvent("two")]),
      buildProto(TemplateBuildState.READY, [logEvent("one"), logEvent("two")]),
    ];
    const rpcClient = {
      getTemplateBuild: vi.fn(async () => create(GetTemplateBuildResponseSchema, { build: responses.shift()! })),
    };
    const seen: string[] = [];

    const existing = { id: "build-1" } as TemplateBuild;
    await makeSdk(rpcClient).waitForTemplateBuild(existing, {
      onEvent: (event) => {
        seen.push(event.type === "log" ? event.data : "");
      },
    });

    expect(seen).toEqual(["one", "two"]);
  });
});

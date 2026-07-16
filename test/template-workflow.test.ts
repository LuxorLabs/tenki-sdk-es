import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { RegistryImageSchema } from "../src/internal/proto/tenki/sandbox/v1/registry_pb.js";
import {
  CreateSessionResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  BuildTemplateResponseSchema,
  CreateTemplateResponseSchema,
  GetTemplateBuildResponseSchema,
  TemplateBuildEventSchema,
  TemplateBuildSchema,
  TemplateBuildState,
  TemplateRuntimeState,
  TemplateSchema,
} from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";
import { TemplateSpec } from "../src/template-spec.js";
import type { TemplateBuildEvent } from "../src/template.js";

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

const DIGEST = "sha256:" + "d".repeat(64);
const DIGEST_REF = `acme/node-api@${DIGEST}`;

function readyBuild(spec: TemplateSpec) {
  return create(TemplateBuildSchema, {
    id: "build-1",
    templateId: "template-1",
    state: TemplateBuildState.READY,
    builderSpec: spec.toProto(),
    specHash: "sha256:" + "e".repeat(64),
    image: create(RegistryImageSchema, { id: "image-1", workspaceSlug: "acme", name: "node-api" }),
    imageDigest: DIGEST,
    imageDigestRef: DIGEST_REF,
    events: [
      create(TemplateBuildEventSchema, { event: { case: "progress", value: { phase: "steps", state: 1 } } }),
      create(TemplateBuildEventSchema, { event: { case: "log", value: { phase: "steps", data: "npm ci ok" } } }),
    ],
  });
}

function sessionResponse(runtimeState = TemplateRuntimeState.UNSPECIFIED, metadata: Record<string, string> = {}) {
  return create(CreateSessionResponseSchema, {
    session: create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
      runtimeState,
      metadata,
    }),
  });
}

function workflowRpcClient(spec: TemplateSpec) {
  return {
    createTemplate: vi.fn(async () =>
      create(CreateTemplateResponseSchema, {
        template: create(TemplateSchema, { id: "template-1", name: "node-api", builderSpec: spec.toProto() }),
      }),
    ),
    buildTemplate: vi.fn(async () =>
      create(BuildTemplateResponseSchema, {
        build: create(TemplateBuildSchema, {
          id: "build-1",
          templateId: "template-1",
          state: TemplateBuildState.PENDING,
        }),
      }),
    ),
    getTemplateBuild: vi.fn(async () => create(GetTemplateBuildResponseSchema, { build: readyBuild(spec) })),
    createSession: vi.fn(async () => sessionResponse(TemplateRuntimeState.READY)),
  };
}

describe("template builder workflow", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs the filesystem workflow: spec -> template -> build -> image -> sandbox", async () => {
    const spec = new TemplateSpec()
      .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
      .workdir("/home/tenki/app")
      .run("npm ci")
      .copy("ops/nginx.conf", "/etc/nginx/nginx.conf")
      .start("npm run dev", {
        runAt: "boot",
        readyWhen: [{ http: "http://127.0.0.1:3000/health" }],
      });
    expect(spec.validate()).toEqual([]);

    const rpcClient = workflowRpcClient(spec);
    const sdk = makeSdk(rpcClient);

    const template = await sdk.createTemplate({ workspaceId: "workspace-1", name: "node-api", spec });
    expect(rpcClient.createTemplate.mock.calls[0]?.[0].builderSpec?.specVersion).toBe("tenki.template.v1");

    const events: TemplateBuildEvent[] = [];
    const build = await sdk.buildTemplate(template, {
      buildSecrets: { GITHUB_TOKEN: "gh_token" },
      waitForCompletion: true,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(rpcClient.buildTemplate.mock.calls[0]?.[0].buildSecrets).toEqual({ GITHUB_TOKEN: "gh_token" });
    expect(events.map((e) => e.type)).toEqual(["progress", "log"]);
    expect(build.state).toBe("READY");
    expect(build.image?.digestRef).toBe(DIGEST_REF);

    const session = await sdk.create({ image: build.image, waitForRuntime: true });
    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.registryRef).toBe(DIGEST_REF);
    expect(request.waitForRuntime).toBe(true);
    expect(session.state).toBe("RUNNING");
  });

  it("runs the memory workflow and restores a READY runtime", async () => {
    const spec = new TemplateSpec()
      .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
      .run("npm ci")
      .startArgs(["npm", "run", "dev"], {
        runAt: "build",
        snapshotMode: "memory",
        readyWhen: { timeoutSeconds: 60, checks: [{ port: 3000 }] },
      });
    expect(spec.validate()).toEqual([]);

    const rpcClient = workflowRpcClient(spec);
    const sdk = makeSdk(rpcClient);

    const template = await sdk.createTemplate({ workspaceId: "workspace-1", name: "node-api", spec });
    const build = await sdk.buildTemplate(template, { waitForCompletion: true });
    expect(build.spec?.toJSON()).toEqual(spec.toJSON());

    const session = await sdk.create({ image: build.image, waitForRuntime: true });
    expect(session.runtimeState).toBe("READY");
  });

  it("reports successful cold fallback as READY with degraded attribution", async () => {
    const rpcClient = {
      createSession: vi.fn(async () =>
        sessionResponse(TemplateRuntimeState.READY, {
          restore_mode: "cold_boot",
          restore_degraded: "true",
          restore_reason: "incompatible_cpu",
        }),
      ),
    };

    const session = await makeSdk(rpcClient).create({
      image: { ref: "acme/node-api", digestRef: DIGEST_REF },
      waitForRuntime: true,
    });

    expect(session.state).toBe("RUNNING");
    expect(session.runtimeState).toBe("READY");
    expect(session.metadata).toMatchObject({
      restore_mode: "cold_boot",
      restore_degraded: "true",
      restore_reason: "incompatible_cpu",
    });
  });
});

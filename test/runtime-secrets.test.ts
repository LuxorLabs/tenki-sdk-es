import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  CreateSessionRequestSchema,
  SandboxService,
  SessionState,
  SnapshotSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { secretFileNames } from "../src/secret-files.js";
import { snapshotFromProto } from "../src/snapshot.js";
import { TemplateSpec } from "../src/template-spec.js";

const refs = { API_TOKEN: "shared-token" };

describe("runtime workspace secret references", () => {
  it.each(["start", "argv", "compose"])(
    "preserves %s refs through builder and authored/protobuf roundtrips",
    (kind) => {
      const source = { ...refs };
      const spec =
        kind === "compose"
          ? new TemplateSpec().processCompose("compose.yaml", { secretEnv: source })
          : kind === "argv"
            ? new TemplateSpec().startArgs(["app"], { secretEnv: source })
            : new TemplateSpec().start("app", { secretEnv: source });
      source.API_TOKEN = "mutated";
      expect(spec.validate()).toEqual([]);
      expect(spec.toProto().runtime?.secretEnv).toEqual(refs);
      expect(TemplateSpec.fromJSON(spec.toJSON()).toProto().runtime?.secretEnv).toEqual(refs);
      expect(TemplateSpec.fromProto(spec.toProto()).toDirectRuntimeProto().secretEnv).toEqual(refs);
    },
  );
  it("validates references and refuses ignored build intent", () => {
    expect(new TemplateSpec().start("app", { secretEnv: { "BAD-TARGET": "token" } }).validate()).not.toEqual([]);
    expect(new TemplateSpec().start("app", { secretEnv: { TOKEN: "not a name" } }).validate()).not.toEqual([]);
    expect(
      new TemplateSpec().runtimeEnv({ API_TOKEN: "plain" }).start("app", { secretEnv: refs }).validate(),
    ).not.toEqual([]);
    expect(() => new TemplateSpec().run("setup").start("app").toDirectRuntimeProto()).toThrow(/runtime settings only/);
    expect(() => new TemplateSpec().start("app", { runAt: "manual" }).toDirectRuntimeProto()).toThrow(/boot runtime/);
  });
  it("sends runtime and overrides for registry launch, and maps read-only secret markers", async () => {
    const seen: ReturnType<typeof create<typeof CreateSessionRequestSchema>>[] = [];
    const client = new TenkiSandbox({
      authToken: "tk_test",
      transport: createRouterTransport((router) =>
        router.service(SandboxService, {
          createSession(request) {
            seen.push(fromBinary(CreateSessionRequestSchema, toBinary(CreateSessionRequestSchema, request)));
            return { session: { id: "session", state: SessionState.RUNNING, hasRuntimeSecrets: true } };
          },
        }),
      ),
    });
    try {
      const session = await client.create({
        image: "team/base:v1",
        directRuntime: new TemplateSpec().workdir("/app").start("app", { secretEnv: refs }),
        secretOverrides: { "shared-token": "local-token" },
        secretFiles: [{ path: "/app/env.tpl-sandbox", content: "TOKEN=secrets://shared-token" }],
        waitReady: false,
      });
      expect(seen[0]).toMatchObject({
        registryRef: "team/base:v1",
        runtime: { secretEnv: refs, entrypoint: { case: "start", value: { workdir: "/app" } } },
        secretOverrides: { "shared-token": "local-token" },
      });
      expect(seen[0].secretFiles[0]?.format).toEqual({ case: "content", value: "TOKEN=secrets://shared-token" });
      expect(session.hasRuntimeSecrets).toBe(true);
      expect(snapshotFromProto(create(SnapshotSchema, { hasRuntimeSecrets: true })).hasRuntimeSecrets).toBe(true);
      await expect(
        client.create({
          directRuntime: new TemplateSpec().start("app", { secretEnv: { GH_TOKEN: "token" } }),
          githubToken: "plain",
          waitReady: false,
        }),
      ).rejects.toThrow(/conflicts with session environment/);
      await expect(
        client.create({
          directRuntime: new TemplateSpec().start("app"),
          fromTemplateSpec: "template",
          waitReady: false,
        }),
      ).rejects.toThrow(/conflicts with fromTemplateSpec/);
      expect(seen).toHaveLength(1);
      await client.create({
        fromTemplateSpec: "template",
        secretOverrides: { "shared-token": "local-token" },
        waitReady: false,
      });
      expect(seen[1].runtime).toBeUndefined();
      expect(seen[1].secretOverrides).toEqual({ "shared-token": "local-token" });
    } finally {
      await client.close();
    }
  });
});

describe("runtime secret files", () => {
  it.each(["start", "argv", "compose"])("preserves %s file declarations without retaining caller state", (kind) => {
    const files = [
      { path: "/app/raw", raw: { name: "RAW" } },
      { path: "/app/.env", content: "TOKEN=secrets://TOKEN" },
      { path: "/app/config.yaml", source: "/app/config.tpl.yaml" },
    ];
    const spec =
      kind === "compose"
        ? new TemplateSpec().processCompose("compose.yaml", { secretFiles: files })
        : kind === "argv"
          ? new TemplateSpec().startArgs(["app"], { secretFiles: files })
          : new TemplateSpec().start("app", { secretFiles: files });
    files[0]!.path = "/etc/unsafe";
    expect(spec.validate()).toEqual([]);
    const runtime = TemplateSpec.fromJSON(spec.toJSON()).toDirectRuntimeProto();
    expect(runtime.secretFiles).toHaveLength(3);
    expect(runtime.secretFiles[0]!.path).toBe("/app/raw");
    expect(new TemplateSpec().start("app", { secretFiles: files }).validate()).not.toEqual([]);
  });
});

it("discovers literal file references consistently", () => {
  expect(
    secretFileNames("a=secrets://TOKEN,b=secrets://TOKEN,literal=\\secrets://IGNORE,header=\\secrets://API"),
  ).toEqual(["TOKEN"]);
  for (const text of ["secrets://", "secrets://9bad", "secrets://" + "a".repeat(129), "bad\u0000"])
    expect(secretFileNames(text)).toBeNull();
});

describe.each([{ header: "Authorization" }, { queryParameter: "token" }, { jsonPointer: "/auth/token" }])(
  "transparent request bindings %j",
  (location) => {
    const rule = {
      name: "token",
      secretName: "API_TOKEN",
      origin: "https://api.example.com",
      methods: ["POST"],
      pathPrefix: "/v1/",
      ...location,
    };
    it.each(["start", "argv", "compose"])("roundtrips %s rules independently of caller mutation", (kind) => {
      const headers = [{ ...rule, methods: [...rule.methods] }];
      const spec =
        kind === "compose"
          ? new TemplateSpec().processCompose("compose.yaml", { secretRequests: headers })
          : kind === "argv"
            ? new TemplateSpec().startArgs(["app"], { secretRequests: headers })
            : new TemplateSpec().start("app", { secretRequests: headers });
      headers[0]!.methods.push("DELETE");
      expect(TemplateSpec.fromJSON(spec.toJSON()).toProto().runtime?.secretRequests[0]).toMatchObject(rule);
      expect(spec.toDirectRuntimeProto().secretRequests[0]?.methods).toEqual(["POST"]);
    });
    it("sends direct bindings without a managed runtime", async () => {
      const client = new TenkiSandbox({
        authToken: "tk_test",
        transport: createRouterTransport((router) =>
          router.service(SandboxService, {
            createSession(request) {
              expect(request.runtime).toBeUndefined();
              expect(request.secretRequests).toHaveLength(1);
              expect(request.secretRequests[0]).toMatchObject(rule);
              return { session: { id: "session", state: SessionState.RUNNING } };
            },
          }),
        ),
      });
      try {
        await client.create({ secretRequests: [rule], waitReady: false });
      } finally {
        await client.close();
      }
    });
  },
);

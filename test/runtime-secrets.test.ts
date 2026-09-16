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
        waitReady: false,
      });
      expect(seen[0]).toMatchObject({
        registryRef: "team/base:v1",
        runtime: { secretEnv: refs, entrypoint: { case: "start", value: { workdir: "/app" } } },
        secretOverrides: { "shared-token": "local-token" },
      });
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

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { TenkiSandbox } from "../../src/client.js";
import { TemplateRuntimeFailedError } from "../../src/errors.js";
import { stdoutText } from "../../src/result.js";
import { TemplateSpec } from "../../src/template-spec.js";
import type { TemplateBuild } from "../../src/template.js";

const liveDescribe = process.env.SANDBOX_E2E === "1" ? describe : describe.skip;
const CPU_OVERRIDE_PREFIX = "sdk-e2e-cpu-override:";

interface SnapshotCPUState {
  cpuProfile: string | null;
  originCPUSignature: string | null;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function psql(sql: string, variables: Record<string, string>): string {
  const dsn = process.env.TENKI_SANDBOX_E2E_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:6444/tenki";
  const args = [dsn, "-Atq", "-v", "ON_ERROR_STOP=1"];
  for (const [key, value] of Object.entries(variables)) {
    args.push("-v", `${key}=${value}`);
  }
  const result = spawnSync("psql", args, {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`psql failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function restoreCPUOverride(snapshotId: string, marker: string): void {
  const restored = psql(
    `
      WITH original AS (
        SELECT substring(:'marker' FROM char_length(:'marker_prefix') + 1)::jsonb AS value
      ), restored AS (
        UPDATE sandbox_snapshots
        SET cpu_profile = original.value->>'cpuProfile',
            origin_cpu_signature = original.value->>'originCPUSignature'
        FROM original
        WHERE id = :'snapshot_id'::uuid
          AND origin_cpu_signature = :'marker'
        RETURNING id
      )
      SELECT count(*) FROM restored;
    `,
    { marker, marker_prefix: CPU_OVERRIDE_PREFIX, snapshot_id: snapshotId },
  );
  if (restored !== "1") throw new Error(`snapshot CPU override was not restored for ${snapshotId}`);
}

function repairLeakedCPUOverrides(): void {
  const rows = psql(
    `
      SELECT id::text || chr(9) || origin_cpu_signature
      FROM sandbox_snapshots
      WHERE origin_cpu_signature LIKE :'marker_prefix' || '%';
    `,
    { marker_prefix: CPU_OVERRIDE_PREFIX },
  );
  for (const row of rows.split("\n").filter(Boolean)) {
    const separator = row.indexOf("\t");
    if (separator < 0) throw new Error("invalid leaked snapshot CPU override row");
    restoreCPUOverride(row.slice(0, separator), row.slice(separator + 1));
  }
}

async function withIncompatibleCPU<T>(snapshotId: string, fn: () => Promise<T>): Promise<T> {
  repairLeakedCPUOverrides();
  const originalJSON = psql(
    `
      SELECT json_build_object(
        'cpuProfile', cpu_profile,
        'originCPUSignature', origin_cpu_signature
      )::text
      FROM sandbox_snapshots
      WHERE id = :'snapshot_id'::uuid;
    `,
    { snapshot_id: snapshotId },
  );
  if (!originalJSON) throw new Error("snapshot CPU metadata was not found");
  const original = JSON.parse(originalJSON) as SnapshotCPUState;
  const marker = `${CPU_OVERRIDE_PREFIX}${JSON.stringify(original)}`;

  psql(
    `
      UPDATE sandbox_snapshots
      SET cpu_profile = 'legacy',
          origin_cpu_signature = :'marker'
      WHERE id = :'snapshot_id'::uuid;
    `,
    { marker, snapshot_id: snapshotId },
  );
  let callbackFailed = false;
  try {
    return await fn();
  } catch (err) {
    callbackFailed = true;
    throw err;
  } finally {
    try {
      restoreCPUOverride(snapshotId, marker);
    } catch (cleanupError) {
      if (!callbackFailed) throw cleanupError;
      console.error("snapshot CPU override cleanup failed", cleanupError);
    }
  }
}

function templateSpec(label: string, memory: boolean): TemplateSpec {
  const startCommand = [
    'if [ "${SDK_E2E_FAIL_RUNTIME:-}" = "1" ]; then exit 42; fi',
    'printf "%s" "$SDK_E2E_RUNTIME" > /home/tenki/app/sdk-e2e-runtime.txt',
    ...(memory ? [] : ["sleep 10"]),
    "exec python3 -m http.server 3000 --directory /home/tenki/app",
  ].join("; ");
  return new TemplateSpec()
    .withGitContext({
      repo: process.env.TENKI_SANDBOX_E2E_GIT_REPO ?? "https://github.com/octocat/Hello-World.git",
      ref: process.env.TENKI_SANDBOX_E2E_GIT_REF ?? "master",
    })
    .buildEnv({ SDK_E2E_BUILD: label })
    .run("test -f README", { name: "verify git checkout" })
    .run(`test "$SDK_E2E_BUILD" = "${label}"`, { name: "verify build env" })
    .writeFile("/home/tenki/app/sdk-e2e.txt", `${label}\n`)
    .runtimeEnv({ SDK_E2E_RUNTIME: `${label}-template` })
    .startArgs(["sh", "-lc", startCommand], {
      runAt: memory ? "build" : "boot",
      ...(memory ? { snapshotMode: "memory" as const } : {}),
      readyWhen: { timeoutSeconds: 60, checks: [{ port: 3000 }] },
    })
    .resources({ cpuCores: 2, memoryMb: 2048, diskSizeGb: 10 });
}

liveDescribe("template builder live E2E", () => {
  it(
    "verifies filesystem, memory restore, and forced cold fallback",
    async () => {
      const sdk = new TenkiSandbox({ cookieName: process.env.TENKI_COOKIE_NAME ?? "tenki_session" });
      const workspaceId = requiredEnv("TENKI_SANDBOX_WORKSPACE_ID");
      const runId = Date.now().toString();
      const templates: Array<{ id: string }> = [];
      const sessions: Array<{ close(): Promise<void> }> = [];
      const imageIds: string[] = [];

      const verifySession = async (
        build: TemplateBuild,
        label: string,
        expectedMode?: string,
        waitForRuntime = true,
      ) => {
        const session = await sdk.create({
          workspaceId,
          image: build.image,
          env: { SDK_E2E_RUNTIME: `${label}-create` },
          waitForRuntime,
        });
        sessions.push(session);
        expect(session.state).toBe("RUNNING");
        if (!waitForRuntime) {
          expect(session.runtimeState).toBe("STARTING");
          const deadline = Date.now() + 60_000;
          while (session.runtimeState === "STARTING" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            await session.refresh();
          }
        }
        expect(session.runtimeState).toBe("READY");
        expect(
          stdoutText(
            await session.exec("cat", {
              args: ["/home/tenki/app/sdk-e2e.txt"],
            }),
          ),
        ).toBe(label);
        expect(
          stdoutText(
            await session.exec("printenv", {
              args: ["SDK_E2E_RUNTIME"],
            }),
          ),
        ).toBe(`${label}-create`);
        expect(
          stdoutText(
            await session.exec("cat", {
              args: ["/home/tenki/app/sdk-e2e-runtime.txt"],
            }),
          ),
        ).toBe(expectedMode === "memory" ? `${label}-template` : `${label}-create`);
        await session.refresh();
        expect(session.runtimeState).toBe("READY");
        expect(session.sourceRegistryImageId).toBe(build.image?.id);
        expect(session.sourceSnapshotId).toBe(build.snapshotId);
        expect(session.sourceRegistryRef).toBe(build.image?.digestRef);
        if (expectedMode) expect(session.metadata.restore_mode).toBe(expectedMode);
        return session;
      };

      try {
        for (const mode of ["filesystem", "memory"] as const) {
          const memory = mode === "memory";
          const label = `ts-${mode}-${runId}`;
          const spec = templateSpec(label, memory);
          expect(spec.validate()).toEqual([]);
          const template = await sdk.createTemplate({
            workspaceId,
            name: label,
            spec,
            tags: ["sdk-e2e", "typescript"],
          });
          templates.push(template);
          const build = await sdk.buildTemplate(template, {
            waitForCompletion: true,
          });
          expect(build.state).toBe("READY");
          expect(build.snapshotId).not.toBe("");
          if (!build.image) throw new Error("template build returned no image");
          expect(build.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(build.image.digestRef).toBe(`${build.image.ref}@${build.image.digest}`);
          expect(build.image.digestRef).not.toContain(build.snapshotId);
          expect(build.imageDigest).toBe(build.image.digest);
          expect(build.imageDigestRef).toBe(build.image.digestRef);
          imageIds.push(build.image.id);

          const session = await verifySession(build, label, memory ? "memory" : undefined, memory);
          if (memory) expect(session.metadata.restore_degraded).toBe("false");
          await session.close();

          if (!memory) {
            let runtimeFailure: TemplateRuntimeFailedError;
            try {
              const unexpectedSession = await sdk.create({
                workspaceId,
                image: build.image,
                env: { SDK_E2E_FAIL_RUNTIME: "1" },
                waitForRuntime: true,
              });
              sessions.push(unexpectedSession);
              throw new Error("runtime failure launch unexpectedly succeeded");
            } catch (err) {
              if (!(err instanceof TemplateRuntimeFailedError)) throw err;
              runtimeFailure = err;
            }
            sessions.push(runtimeFailure.session);
            expect(runtimeFailure.session).toMatchObject({ state: "RUNNING", runtimeState: "FAILED" });
            await runtimeFailure.session.close();
          }

          if (memory) {
            await withIncompatibleCPU(build.snapshotId, async () => {
              const cold = await verifySession(build, label, "cold_boot");
              expect(cold.metadata).toMatchObject({
                restore_degraded: "true",
                restore_reason: "incompatible_cpu",
              });
              await cold.close();
            });
          }
        }
      } finally {
        for (const session of sessions.reverse()) {
          await session.close().catch(() => undefined);
        }
        for (const template of templates.reverse()) {
          await sdk.deleteTemplate(template.id).catch(() => undefined);
        }
        for (const imageId of imageIds.reverse()) {
          await sdk.deleteRegistryImage(imageId, "SDK E2E cleanup").catch(() => undefined);
        }
      }
    },
    20 * 60 * 1000,
  );
});

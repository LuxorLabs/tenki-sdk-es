import { describe, expect, it } from "vitest";

import { InvalidTemplateSpecError } from "../src/errors.js";
import { TemplateSpec } from "../src/template-spec.js";

describe("TemplateSpec", () => {
  it("defaults to the sandbox base image and v1 spec version", () => {
    const json = new TemplateSpec().toJSON() as Record<string, unknown>;
    expect(json).toEqual({
      specVersion: "tenki.template.v1",
      base: { image: "sandbox" },
    });
  });

  it("is immutable: fluent methods return new specs", () => {
    const base = new TemplateSpec().workdir("/home/tenki/app");
    const withStep = base.run("npm ci");
    const withImage = base.fromImage("sandbox-v2");

    expect((base.toJSON() as { steps?: unknown }).steps).toBeUndefined();
    expect((withStep.toJSON() as { steps: unknown[] }).steps).toHaveLength(1);
    expect((base.toJSON() as { base: unknown }).base).toEqual({ image: "sandbox" });
    expect((withImage.toJSON() as { base: unknown }).base).toEqual({ image: "sandbox-v2" });
  });

  it("does not expose a local hash", () => {
    const spec = new TemplateSpec();
    expect((spec as unknown as Record<string, unknown>).hash).toBeUndefined();
    expect((spec as unknown as Record<string, unknown>).specHash).toBeUndefined();
  });

  it("emits the canonical filesystem example", () => {
    const spec = new TemplateSpec()
      .workdir("/home/tenki/app")
      .withGitContext({
        repo: "https://github.com/acme/app",
        ref: "main",
        checkout: { dest: "/home/tenki/app", mode: "contents" },
        ignore: [".git/cache"],
      })
      .buildEnv({ NODE_ENV: "production" })
      .run("npm ci", { timeoutSeconds: 1800 })
      .copy("ops/nginx.conf", "/etc/nginx/nginx.conf")
      .writeFile("/home/tenki/app/.template-built", "ready\n")
      .runtimeEnv({ PORT: "3000" })
      .start("npm run dev", {
        workdir: "/home/tenki/app",
        runAt: "build",
        snapshotMode: "filesystem",
        readyWhen: {
          timeoutSeconds: 60,
          pollIntervalSeconds: 1,
          checks: [{ http: { url: "http://127.0.0.1:3000/health", successStatusCodes: [200, 204] } }],
        },
        stopGraceSeconds: 30,
      })
      .resources({ cpuCores: 2, memoryMb: 4096, diskSizeGb: 10 });

    expect(spec.toJSON()).toEqual({
      specVersion: "tenki.template.v1",
      base: { image: "sandbox" },
      workdir: "/home/tenki/app",
      context: {
        source: { git: { repo: "https://github.com/acme/app", ref: "main" } },
        checkout: { dest: "/home/tenki/app", mode: "contents" },
        ignore: [".git/cache"],
      },
      build: { env: { NODE_ENV: "production" } },
      steps: [
        { run: { command: "npm ci", timeoutSeconds: 1800 } },
        { copy: { src: "ops/nginx.conf", dest: "/etc/nginx/nginx.conf" } },
        { writeFile: { path: "/home/tenki/app/.template-built", content: btoa("ready\n") } },
      ],
      runtime: {
        env: { PORT: "3000" },
        runAt: "build",
        start: { command: "npm run dev", workdir: "/home/tenki/app" },
        snapshotMode: "filesystem",
        readyWhen: {
          timeoutSeconds: 60,
          pollIntervalSeconds: 1,
          checks: [{ http: { url: "http://127.0.0.1:3000/health", successStatusCodes: [200, 204] } }],
        },
        stopGraceSeconds: 30,
      },
      resources: { cpuCores: 2, memoryMb: 4096, diskSizeGb: 10 },
    });
    expect(spec.validate()).toEqual([]);
  });

  it("builds a memory runtime with all readiness check kinds", () => {
    const spec = new TemplateSpec()
      .withGitContext({ repo: "https://github.com/acme/app", ref: "main" })
      .startArgs(["npm", "run", "dev"], {
        workdir: "/home/tenki/app",
        runAt: "build",
        snapshotMode: "memory",
        readyWhen: [
          { port: 3000 },
          { http: "http://127.0.0.1:3000/health" },
          { exec: { command: "test -f /home/tenki/app/.ready", timeoutSeconds: 5 } },
        ],
      });

    const runtime = (spec.toJSON() as { runtime: Record<string, unknown> }).runtime;
    expect(runtime.start).toEqual({ argv: ["npm", "run", "dev"], workdir: "/home/tenki/app" });
    expect(runtime.snapshotMode).toBe("memory");
    expect(runtime.readyWhen).toEqual({
      // Shorthand check lists get the documented default deadline.
      timeoutSeconds: 60,
      checks: [
        { port: 3000 },
        { http: { url: "http://127.0.0.1:3000/health" } },
        { exec: { command: "test -f /home/tenki/app/.ready", timeoutSeconds: 5 } },
      ],
    });
    expect(spec.validate()).toEqual([]);
  });

  it("builds a process-compose runtime", () => {
    const spec = new TemplateSpec().runtimeEnv({ APP_ENV: "development" }).processCompose("process-compose.yaml", {
      workdir: "/home/tenki/app",
      envFiles: [".env.template"],
      runAt: "boot",
      restartPolicy: "never",
      stopGraceSeconds: 30,
    });

    expect((spec.toJSON() as { runtime: unknown }).runtime).toEqual({
      env: { APP_ENV: "development" },
      runAt: "boot",
      restartPolicy: "never",
      processCompose: {
        configPath: "process-compose.yaml",
        workdir: "/home/tenki/app",
        envFiles: [".env.template"],
      },
      stopGraceSeconds: 30,
    });
    expect(spec.validate()).toEqual([]);
  });

  it("selects parent template and snapshot bases from resource objects or ids", () => {
    const templateId = "01900000-0000-7000-8000-000000000001";
    const snapshotId = "01900000-0000-7000-8000-000000000002";
    expect((new TemplateSpec().fromTemplate({ id: templateId }).toJSON() as { base: unknown }).base).toEqual({
      templateId,
    });
    expect((new TemplateSpec().fromSnapshot(snapshotId).toJSON() as { base: unknown }).base).toEqual({
      snapshotId,
    });
  });

  it("compiles package helpers into steps", () => {
    const spec = new TemplateSpec()
      .apt(["curl", "jq"])
      .pip(["requests"])
      .npm(["typescript"], { name: "Install TS" })
      .bun(["hono"]);
    expect((spec.toJSON() as { steps: unknown[] }).steps).toEqual([
      { apt: { packages: ["curl", "jq"] } },
      { pip: { packages: ["requests"] } },
      { name: "Install TS", npm: { packages: ["typescript"] } },
      { bun: { packages: ["hono"] } },
    ]);
  });

  it("keeps declared file operation order", () => {
    const spec = new TemplateSpec()
      .mkdir("/opt/app", { parents: true })
      .rename("/opt/app/a", "/opt/app/b")
      .symlink("/opt/app/b", "/usr/local/bin/app")
      .remove("/tmp/scratch", { recursive: true });
    expect((spec.toJSON() as { steps: unknown[] }).steps).toEqual([
      { mkdir: { path: "/opt/app", parents: true } },
      { rename: { src: "/opt/app/a", dest: "/opt/app/b" } },
      { symlink: { target: "/opt/app/b", path: "/usr/local/bin/app" } },
      { remove: { path: "/tmp/scratch", recursive: true } },
    ]);
  });

  it("round-trips through strict JSON", () => {
    const spec = new TemplateSpec()
      .fromImage("sandbox-v2")
      .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
      .run("npm ci", { name: "Install dependencies" })
      .runtimeEnv({ NODE_ENV: "production" })
      .startArgs(["npm", "start"], { runAt: "boot", readyWhen: [{ http: "http://localhost:3000/health" }] });

    const restored = TemplateSpec.fromJSON(JSON.stringify(spec));
    expect(restored.toJSON()).toEqual(spec.toJSON());
  });

  it("accepts short authored and legacy protobuf enum values", () => {
    const short = TemplateSpec.fromJSON({
      specVersion: "tenki.template.v1",
      base: { image: "sandbox" },
      context: {
        source: { git: { repo: "https://github.com/acme/app", ref: "main" } },
        checkout: { mode: "directory", name: "app" },
      },
      build: { env: { KEEP: "TEMPLATE_SNAPSHOT_MODE_MEMORY" } },
      runtime: {
        runAt: "manual",
        restartPolicy: "always",
        start: { command: "npm start" },
      },
    });
    expect(short.toJSON()).toMatchObject({
      context: { checkout: { mode: "directory" } },
      build: { env: { KEEP: "TEMPLATE_SNAPSHOT_MODE_MEMORY" } },
      runtime: { runAt: "manual", restartPolicy: "always" },
    });

    const legacy = TemplateSpec.fromJSON({
      specVersion: "tenki.template.v1",
      base: { image: "sandbox" },
      context: {
        source: { git: { repo: "https://github.com/acme/app", ref: "main" } },
        checkout: { mode: "TEMPLATE_CHECKOUT_MODE_CONTENTS" },
      },
      runtime: {
        runAt: "TEMPLATE_RUNTIME_RUN_AT_BUILD",
        restartPolicy: "TEMPLATE_RESTART_POLICY_ON_FAILURE",
        snapshotMode: "TEMPLATE_SNAPSHOT_MODE_MEMORY",
        start: { command: "npm start" },
        readyWhen: { timeoutSeconds: 60, checks: [{ port: 3000 }] },
      },
    });
    expect(legacy.toJSON()).toMatchObject({
      context: { checkout: { mode: "contents" } },
      runtime: { runAt: "build", restartPolicy: "on-failure", snapshotMode: "memory" },
    });
  });

  it("rejects unknown short enum values", () => {
    expect(() =>
      TemplateSpec.fromJSON({
        specVersion: "tenki.template.v1",
        base: { image: "sandbox" },
        runtime: { runAt: "startup", start: { command: "npm start" } },
      }),
    ).toThrow(InvalidTemplateSpecError);
  });

  it("rejects unknown JSON fields", () => {
    expect(() =>
      TemplateSpec.fromJSON({ specVersion: "tenki.template.v1", base: { image: "sandbox" }, bogus: true }),
    ).toThrow(InvalidTemplateSpecError);
  });

  it("rejects malformed JSON strings", () => {
    try {
      TemplateSpec.fromJSON("{not json");
      expect.unreachable("expected malformed JSON to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTemplateSpecError);
      expect((err as InvalidTemplateSpecError).cause).toBeInstanceOf(SyntaxError);
    }
  });

  describe("validate", () => {
    it("flags unsupported spec versions from JSON", () => {
      const spec = TemplateSpec.fromJSON({ specVersion: "tenki.template.v2", base: { image: "sandbox" } });
      expect(spec.validate()).toContainEqual({
        field: "specVersion",
        message: 'spec_version must be "tenki.template.v1"',
      });
    });

    it("requires a base source", () => {
      const spec = TemplateSpec.fromJSON({ specVersion: "tenki.template.v1" });
      expect(spec.validate()).toContainEqual({ field: "base", message: "exactly one base source is required" });
    });

    it("rejects empty base images and malformed parent ids", () => {
      expect(new TemplateSpec().fromImage(" ").validate()).toContainEqual({
        field: "base.image",
        message: "image must not be empty",
      });
      expect(new TemplateSpec().fromTemplate("not-a-uuid").validate()).toContainEqual({
        field: "base.templateId",
        message: "template_id must be a UUID",
      });
      expect(new TemplateSpec().fromSnapshot("not-a-uuid").validate()).toContainEqual({
        field: "base.snapshotId",
        message: "snapshot_id must be a UUID",
      });
    });

    it("requires absolute workdirs", () => {
      expect(new TemplateSpec().workdir("relative/path").validate()).toContainEqual({
        field: "workdir",
        message: "workdir must be an absolute path",
      });
    });

    it("requires a Git context for copy steps", () => {
      expect(new TemplateSpec().copy("ops/a.conf", "/etc/a.conf").validate()).toContainEqual({
        field: "steps[0].copy",
        message: "copy steps require a Git context",
      });
    });

    it("keeps copy sources context-relative", () => {
      const spec = new TemplateSpec().withGitContext({ repo: "https://github.com/acme/app", ref: "main" });
      expect(spec.copy("/abs/path", "/etc/a.conf").validate()).toContainEqual({
        field: "steps[0].copy.src",
        message: "src must be context-relative and cannot traverse above context",
      });
      expect(spec.copy("../escape", "/etc/a.conf").validate()).toContainEqual({
        field: "steps[0].copy.src",
        message: "src must be context-relative and cannot traverse above context",
      });
      expect(spec.copy("ops/a.conf", "etc/a.conf").validate()).toContainEqual({
        field: "steps[0].copy.dest",
        message: "dest must be an absolute path",
      });
    });

    it("requires exactly one of command or argv for run steps", () => {
      const spec = TemplateSpec.fromJSON({
        specVersion: "tenki.template.v1",
        base: { image: "sandbox" },
        steps: [{ run: { command: "npm ci", argv: ["npm", "ci"] } }, { run: {} }],
      });
      expect(spec.validate()).toContainEqual({
        field: "steps[0].run",
        message: "exactly one of command or argv is required",
      });
      expect(spec.validate()).toContainEqual({
        field: "steps[1].run",
        message: "exactly one of command or argv is required",
      });
    });

    it("rejects empty package lists", () => {
      expect(new TemplateSpec().apt([]).validate()).toContainEqual({
        field: "steps[0].apt.packages",
        message: "at least one package is required",
      });
    });

    it("requires absolute paths for file operations", () => {
      const spec = new TemplateSpec().mkdir("relative").remove("also/relative");
      expect(spec.validate()).toContainEqual({
        field: "steps[0].mkdir.path",
        message: "path must be an absolute path",
      });
      expect(spec.validate()).toContainEqual({
        field: "steps[1].remove.path",
        message: "path must be an absolute path",
      });
    });

    it("requires ready_when for build runtime", () => {
      const spec = new TemplateSpec().start("npm run dev", { runAt: "build" });
      expect(spec.validate()).toContainEqual({
        field: "runtime.readyWhen",
        message: "build runtime requires ready_when",
      });
    });

    it("restricts snapshot_mode to build runtime", () => {
      const spec = new TemplateSpec().start("npm run dev", { runAt: "boot", snapshotMode: "memory" });
      expect(spec.validate()).toContainEqual({
        field: "runtime.snapshotMode",
        message: "snapshot_mode is only valid for build runtime",
      });
    });

    it("requires a runtime entrypoint when runtime is configured", () => {
      const spec = new TemplateSpec().runtimeEnv({ NODE_ENV: "production" });
      expect(spec.validate()).toContainEqual({
        field: "runtime",
        message: "exactly one runtime entrypoint is required",
      });
    });

    it("restricts HTTP readiness checks to localhost", () => {
      const spec = new TemplateSpec().start("npm run dev", {
        runAt: "build",
        readyWhen: [{ http: "https://example.com/health" }],
      });
      expect(spec.validate()).toContainEqual({
        field: "runtime.readyWhen.checks[0].http.url",
        message: "url must target localhost over http(s)",
      });
    });

    it("bounds readiness ports and timeouts", () => {
      const spec = new TemplateSpec().start("npm run dev", {
        runAt: "build",
        readyWhen: { timeoutSeconds: 0, checks: [{ port: 0 }] },
      });
      expect(spec.validate()).toContainEqual({
        field: "runtime.readyWhen.timeoutSeconds",
        message: "timeout_seconds must be between 1 and 86400",
      });
      expect(spec.validate()).toContainEqual({
        field: "runtime.readyWhen.checks[0].port",
        message: "port must be between 1 and 65535",
      });
    });

    it("keeps process-compose paths workdir-relative", () => {
      const spec = new TemplateSpec().processCompose("/abs/process-compose.yaml", {
        envFiles: ["../escape.env"],
      });
      expect(spec.validate()).toContainEqual({
        field: "runtime.processCompose.configPath",
        message: "config_path must be workdir-relative and cannot traverse above it",
      });
      expect(spec.validate()).toContainEqual({
        field: "runtime.processCompose.envFiles[0]",
        message: "env_files must be workdir-relative and cannot traverse above it",
      });
    });

    it("mirrors resource, timeout, mode, and runtime workdir bounds", () => {
      const violations = new TemplateSpec()
        .run("npm ci", { timeoutSeconds: 86401 })
        .writeFile("/tmp/file", "x", { mode: 4096 })
        .mkdir("/tmp/dir", { mode: 4096 })
        .start("npm start", { workdir: "relative" })
        .resources({ cpuCores: 129, memoryMb: 513 })
        .validate();

      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "steps[0].run.timeoutSeconds" }),
          expect.objectContaining({ field: "steps[1].writeFile.mode" }),
          expect.objectContaining({ field: "steps[2].mkdir.mode" }),
          expect.objectContaining({ field: "runtime.start.workdir" }),
          expect.objectContaining({ field: "resources.cpuCores" }),
          expect.objectContaining({ field: "resources.memoryMb" }),
        ]),
      );
    });

    it("rejects duplicate and option-shaped package names", () => {
      const violations = new TemplateSpec().npm(["typescript", "typescript", "--ignore-scripts"]).validate();
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "steps[0].npm.packages", message: "packages must be unique" }),
          expect.objectContaining({ field: "steps[0].npm.packages[2]" }),
        ]),
      );
    });

    it("validates readiness status codes and exec timeouts", () => {
      const violations = new TemplateSpec()
        .start("npm start", {
          readyWhen: [
            { http: { url: "http://localhost:3000", successStatusCodes: [99, 200, 200] } },
            { exec: { command: "true", timeoutSeconds: 301 } },
          ],
        })
        .validate();
      expect(violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "runtime.readyWhen.checks[0].http.successStatusCodes",
            message: "status codes must be unique",
          }),
          expect.objectContaining({ field: "runtime.readyWhen.checks[0].http.successStatusCodes[0]" }),
          expect.objectContaining({ field: "runtime.readyWhen.checks[1].exec.timeoutSeconds" }),
        ]),
      );
    });
  });
});

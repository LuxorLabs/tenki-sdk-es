import { clone, create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";

import { InvalidTemplateSpecError } from "./errors.js";
import type {
  TemplateBuildSpec as ProtoTemplateBuildSpec,
  TemplateRuntime as ProtoTemplateRuntime,
  TemplateRunStep,
  TemplateSnapshotCheck,
  TemplateSnapshotWhen,
  TemplateStep,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import {
  TemplateBaseSchema,
  TemplateBuildConfigSchema,
  TemplateBuildSpecSchema,
  TemplateCheckoutMode,
  TemplateCheckoutSchema,
  TemplateContextSchema,
  TemplateCopyStepSchema,
  TemplateExecReadyCheckSchema,
  TemplateHTTPReadyCheckSchema,
  TemplateMakeDirStepSchema,
  TemplatePackageStepSchema,
  TemplateProcessComposeRuntimeSchema,
  TemplateRemoveStepSchema,
  TemplateRenameStepSchema,
  TemplateResourcesSchema,
  TemplateRestartPolicy,
  TemplateRunStepSchema,
  TemplateRuntimeRunAt,
  TemplateRuntimeSchema,
  TemplateSnapshotCheckSchema,
  TemplateSnapshotMode,
  TemplateSnapshotWhenSchema,
  TemplateStartRuntimeSchema,
  TemplateStepSchema,
  TemplateSymlinkStepSchema,
  TemplateWriteFileStepSchema,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";
import { secretFileToProto, validSecretFiles, type RuntimeSecretFile } from "./secret-files.js";
import { secretRequestToProto, type SecretRequestBinding } from "./secret-requests.js";

export const TEMPLATE_SPEC_VERSION = "tenki.template.v1";

/** Default readiness deadline applied when a shorthand check list omits one. */
const DEFAULT_READY_TIMEOUT_SECONDS = 60;

export interface GitContextOptions {
  repo: string;
  /** Branch, tag, or commit SHA. */
  ref: string;
  checkout?: {
    /** Absolute guest path; defaults to the template workdir. */
    dest?: string;
    /** "contents" places repository contents in dest; "directory" under a child directory. */
    mode?: "contents" | "directory";
    /** Child directory name; only valid in directory mode. */
    name?: string;
  };
  ignore?: string[];
}

export interface TemplateStepOptions {
  name?: string;
}

export interface TemplateRunOptions extends TemplateStepOptions {
  workdir?: string;
  timeoutSeconds?: number;
}

export interface TemplateWriteFileOptions extends TemplateStepOptions {
  mode?: number;
}

export interface TemplateMkdirOptions extends TemplateStepOptions {
  parents?: boolean;
  mode?: number;
}

export interface TemplateRemoveOptions extends TemplateStepOptions {
  recursive?: boolean;
}

export type TemplateReadyCheck =
  | { port: number }
  | { http: string | { url: string; successStatusCodes?: number[] } }
  | { exec: string | { command?: string; argv?: string[]; timeoutSeconds?: number } };

export interface TemplateReadyWhen {
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
  checks?: TemplateReadyCheck[];
}

export type TemplateRunAt = "boot" | "build" | "manual";
export type TemplateRestartPolicyOption = "never" | "on-failure" | "always";
export type TemplateSnapshotModeOption = "filesystem" | "memory";

export interface TemplateRuntimeOptions {
  secretRequests?: SecretRequestBinding[];
  /** Environment targets mapped to secret names in the launching workspace. */
  secretEnv?: Record<string, string>;
  secretFiles?: RuntimeSecretFile[];
  runAt?: TemplateRunAt;
  restartPolicy?: TemplateRestartPolicyOption;
  snapshotMode?: TemplateSnapshotModeOption;
  readyWhen?: TemplateReadyCheck[] | TemplateReadyWhen;
  stopGraceSeconds?: number;
}

export interface TemplateStartOptions extends TemplateRuntimeOptions {
  workdir?: string;
}

export interface TemplateProcessComposeOptions extends TemplateRuntimeOptions {
  workdir?: string;
  /** Dotenv files loaded explicitly, workdir-relative. */
  envFiles?: string[];
}

export interface TemplateSpecResources {
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;
}

export interface TemplateSpecViolation {
  field: string;
  message: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALHOST_HTTP_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(\/.*)?$/;
const PACKAGE_RE = /^[^-\x00][^\x00]*$/;
const MAX_PATH_LENGTH = 4096;

const AUTHORED_ENUM_FIELDS: Record<string, Record<string, string>> = {
  "context.checkout.mode": {
    contents: "TEMPLATE_CHECKOUT_MODE_CONTENTS",
    directory: "TEMPLATE_CHECKOUT_MODE_DIRECTORY",
  },
  "runtime.runAt": {
    boot: "TEMPLATE_RUNTIME_RUN_AT_BOOT",
    build: "TEMPLATE_RUNTIME_RUN_AT_BUILD",
    manual: "TEMPLATE_RUNTIME_RUN_AT_MANUAL",
  },
  "runtime.run_at": {
    boot: "TEMPLATE_RUNTIME_RUN_AT_BOOT",
    build: "TEMPLATE_RUNTIME_RUN_AT_BUILD",
    manual: "TEMPLATE_RUNTIME_RUN_AT_MANUAL",
  },
  "runtime.restartPolicy": {
    never: "TEMPLATE_RESTART_POLICY_NEVER",
    "on-failure": "TEMPLATE_RESTART_POLICY_ON_FAILURE",
    always: "TEMPLATE_RESTART_POLICY_ALWAYS",
  },
  "runtime.restart_policy": {
    never: "TEMPLATE_RESTART_POLICY_NEVER",
    "on-failure": "TEMPLATE_RESTART_POLICY_ON_FAILURE",
    always: "TEMPLATE_RESTART_POLICY_ALWAYS",
  },
  "runtime.snapshotMode": {
    filesystem: "TEMPLATE_SNAPSHOT_MODE_FILESYSTEM",
    memory: "TEMPLATE_SNAPSHOT_MODE_MEMORY",
  },
  "runtime.snapshot_mode": {
    filesystem: "TEMPLATE_SNAPSHOT_MODE_FILESYSTEM",
    memory: "TEMPLATE_SNAPSHOT_MODE_MEMORY",
  },
};

function normalizeAuthoredEnums(value: JsonValue, toAuthored: boolean, path: string[] = []): JsonValue {
  if (Array.isArray(value)) return value.map((item) => normalizeAuthoredEnums(item, toAuthored, path));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeAuthoredEnums(item, toAuthored, [...path, key])]),
    );
  }
  if (typeof value !== "string") return value;

  const values = AUTHORED_ENUM_FIELDS[path.join(".")];
  if (!values) return value;
  if (!toAuthored) return values[value] ?? value;
  return Object.entries(values).find(([, protobufName]) => protobufName === value)?.[0] ?? value;
}

/** Immutable fluent builder for the typed v1 template build spec; defaults to base image "sandbox". */
export class TemplateSpec {
  private proto: ProtoTemplateBuildSpec;

  constructor() {
    this.proto = create(TemplateBuildSpecSchema, {
      specVersion: TEMPLATE_SPEC_VERSION,
      base: { source: { case: "image", value: "sandbox" } },
    });
  }

  /** Strictly decode authored JSON with short or protobuf enum names; unknown fields are rejected. */
  static fromJSON(json: string | JsonValue): TemplateSpec {
    let value: JsonValue;
    if (typeof json === "string") {
      try {
        value = JSON.parse(json) as JsonValue;
      } catch (err) {
        throw new InvalidTemplateSpecError(`invalid template spec JSON: ${err instanceof Error ? err.message : err}`, {
          cause: err instanceof Error ? err : undefined,
        });
      }
    } else {
      value = json;
    }
    try {
      return TemplateSpec.fromProto(fromJson(TemplateBuildSpecSchema, normalizeAuthoredEnums(value, false)));
    } catch (err) {
      if (err instanceof InvalidTemplateSpecError) throw err;
      throw new InvalidTemplateSpecError(`invalid template spec: ${err instanceof Error ? err.message : err}`, {
        cause: err instanceof Error ? err : undefined,
      });
    }
  }

  /** @internal */
  static fromProto(proto: ProtoTemplateBuildSpec): TemplateSpec {
    const spec = new TemplateSpec();
    spec.proto = clone(TemplateBuildSpecSchema, proto);
    return spec;
  }

  /** @internal */
  toProto(): ProtoTemplateBuildSpec {
    return clone(TemplateBuildSpecSchema, this.proto);
  }

  /** @internal Extract the managed runtime for direct Session launch. */
  toDirectRuntimeProto(): ProtoTemplateRuntime {
    const p = this.toProto();
    if (
      p.base?.source.case !== "image" ||
      p.base.source.value !== "sandbox" ||
      p.context ||
      p.build ||
      p.steps.length ||
      p.resources
    ) {
      throw new InvalidTemplateSpecError(
        "directRuntime accepts runtime settings only; configure the launch image and resources on create",
      );
    }
    const violations = this.validate();
    if (violations.length)
      throw new InvalidTemplateSpecError(violations.map((v) => `${v.field}: ${v.message}`).join("; "));
    if (
      !p.runtime ||
      (p.runtime.runAt !== TemplateRuntimeRunAt.UNSPECIFIED && p.runtime.runAt !== TemplateRuntimeRunAt.BOOT)
    ) {
      throw new InvalidTemplateSpecError("directRuntime requires a boot runtime entrypoint");
    }
    if (p.runtime.entrypoint.case && !p.runtime.entrypoint.value.workdir)
      p.runtime.entrypoint.value.workdir = p.workdir;
    return p.runtime;
  }

  /** Authored JSON document with short enum values; `JSON.stringify(spec)` uses this. */
  toJSON(): JsonValue {
    return normalizeAuthoredEnums(toJson(TemplateBuildSpecSchema, this.proto), true);
  }

  /** Base on a Tenki-managed image ID or qualified Tenki registry ref. */
  fromImage(image: string): TemplateSpec {
    return this.update((p) => {
      p.base = create(TemplateBaseSchema, { source: { case: "image", value: image.trim() } });
    });
  }

  /** Base on a parent template. */
  fromTemplate(template: string | { id: string }): TemplateSpec {
    const id = typeof template === "string" ? template.trim() : template.id;
    return this.update((p) => {
      p.base = create(TemplateBaseSchema, { source: { case: "templateId", value: id } });
    });
  }

  /** Base on a parent snapshot. */
  fromSnapshot(snapshot: string | { id: string }): TemplateSpec {
    const id = typeof snapshot === "string" ? snapshot.trim() : snapshot.id;
    return this.update((p) => {
      p.base = create(TemplateBaseSchema, { source: { case: "snapshotId", value: id } });
    });
  }

  /** Backend-fetched Git build context; the .git directory is retained unless ignored. */
  withGitContext(context: GitContextOptions): TemplateSpec {
    return this.update((p) => {
      p.context = create(TemplateContextSchema, {
        source: { source: { case: "git", value: { repo: context.repo, ref: context.ref } } },
        ignore: [...(context.ignore ?? [])],
      });
      if (context.checkout) {
        p.context.checkout = create(TemplateCheckoutSchema, {
          dest: context.checkout.dest ?? "",
          mode:
            context.checkout.mode === "directory"
              ? TemplateCheckoutMode.DIRECTORY
              : context.checkout.mode === "contents"
                ? TemplateCheckoutMode.CONTENTS
                : TemplateCheckoutMode.UNSPECIFIED,
        });
        if (context.checkout.name !== undefined) p.context.checkout.name = context.checkout.name;
      }
    });
  }

  /** Default directory for Git checkout, build commands, and runtime processes. */
  workdir(path: string): TemplateSpec {
    return this.update((p) => {
      p.workdir = path;
    });
  }

  /** Persisted non-secret build environment, merged into any previous values. */
  buildEnv(env: Record<string, string>): TemplateSpec {
    return this.update((p) => {
      p.build ??= create(TemplateBuildConfigSchema, {});
      p.build.env = { ...p.build.env, ...env };
    });
  }

  /** Shell-form build command (sh -lc). */
  run(command: string, options?: TemplateRunOptions): TemplateSpec {
    return this.addStep(options?.name, { case: "run", value: runStep({ command }, options) });
  }

  /** Argv-form build command executed directly, without a shell. */
  runArgs(argv: string[], options?: TemplateRunOptions): TemplateSpec {
    return this.addStep(options?.name, { case: "run", value: runStep({ argv: [...argv] }, options) });
  }

  /** Copy from the materialized Git context (src is context-relative) to an absolute guest path. */
  copy(src: string, dest: string, options?: TemplateStepOptions): TemplateSpec {
    return this.addStep(options?.name, { case: "copy", value: create(TemplateCopyStepSchema, { src, dest }) });
  }

  /** Write an inline small file at an absolute guest path. */
  writeFile(path: string, content: string | Uint8Array, options?: TemplateWriteFileOptions): TemplateSpec {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    const value = create(TemplateWriteFileStepSchema, { path, content: bytes });
    if (options?.mode !== undefined) value.mode = options.mode;
    return this.addStep(options?.name, { case: "writeFile", value });
  }

  mkdir(path: string, options?: TemplateMkdirOptions): TemplateSpec {
    const value = create(TemplateMakeDirStepSchema, { path, parents: options?.parents ?? false });
    if (options?.mode !== undefined) value.mode = options.mode;
    return this.addStep(options?.name, { case: "mkdir", value });
  }

  remove(path: string, options?: TemplateRemoveOptions): TemplateSpec {
    return this.addStep(options?.name, {
      case: "remove",
      value: create(TemplateRemoveStepSchema, { path, recursive: options?.recursive ?? false }),
    });
  }

  rename(src: string, dest: string, options?: TemplateStepOptions): TemplateSpec {
    return this.addStep(options?.name, { case: "rename", value: create(TemplateRenameStepSchema, { src, dest }) });
  }

  symlink(target: string, path: string, options?: TemplateStepOptions): TemplateSpec {
    return this.addStep(options?.name, {
      case: "symlink",
      value: create(TemplateSymlinkStepSchema, { target, path }),
    });
  }

  apt(packages: string[], options?: TemplateStepOptions): TemplateSpec {
    return this.addPackageStep("apt", packages, options);
  }

  pip(packages: string[], options?: TemplateStepOptions): TemplateSpec {
    return this.addPackageStep("pip", packages, options);
  }

  npm(packages: string[], options?: TemplateStepOptions): TemplateSpec {
    return this.addPackageStep("npm", packages, options);
  }

  bun(packages: string[], options?: TemplateStepOptions): TemplateSpec {
    return this.addPackageStep("bun", packages, options);
  }

  /** Persisted process-scoped runtime environment, merged into any previous values. */
  runtimeEnv(env: Record<string, string>): TemplateSpec {
    return this.update((p) => {
      const runtime = ensureRuntime(p);
      runtime.env = { ...runtime.env, ...env };
    });
  }

  /** Single shell-form runtime start command. */
  start(command: string, options?: TemplateStartOptions): TemplateSpec {
    return this.setStart({ command }, options);
  }

  /** Single argv-form runtime start command. */
  startArgs(argv: string[], options?: TemplateStartOptions): TemplateSpec {
    return this.setStart({ argv: [...argv] }, options);
  }

  /** Process-compose supervised runtime; configPath and envFiles are workdir-relative. */
  processCompose(configPath: string, options?: TemplateProcessComposeOptions): TemplateSpec {
    return this.update((p) => {
      const runtime = ensureRuntime(p);
      runtime.entrypoint = {
        case: "processCompose",
        value: create(TemplateProcessComposeRuntimeSchema, {
          configPath,
          workdir: options?.workdir ?? "",
          envFiles: [...(options?.envFiles ?? [])],
        }),
      };
      applyRuntimeOptions(runtime, options);
    });
  }

  /** Readiness contract shared by build, boot, manual start, and cold fallback. */
  readyWhen(readyWhen: TemplateReadyCheck[] | TemplateReadyWhen): TemplateSpec {
    return this.update((p) => {
      ensureRuntime(p).readyWhen = readyWhenToProto(readyWhen);
    });
  }

  /** Default CPU/memory/disk for the build VM and launched sandboxes. */
  resources(resources: TemplateSpecResources): TemplateSpec {
    return this.update((p) => {
      p.resources = create(TemplateResourcesSchema, {
        cpuCores: resources.cpuCores ?? 0,
        memoryMb: resources.memoryMb ?? 0,
        diskSizeGb: resources.diskSizeGb ?? 0,
      });
    });
  }

  /** Best-effort local field/message violations; server validation remains authoritative. */
  validate(): TemplateSpecViolation[] {
    const v: TemplateSpecViolation[] = [];
    const p = this.proto;

    if (p.specVersion !== TEMPLATE_SPEC_VERSION) {
      v.push({ field: "specVersion", message: `spec_version must be "${TEMPLATE_SPEC_VERSION}"` });
    }

    if (!p.base || p.base.source.case === undefined) {
      v.push({ field: "base", message: "exactly one base source is required" });
    } else if (p.base.source.case === "image" && p.base.source.value.trim() === "") {
      v.push({ field: "base.image", message: "image must not be empty" });
    } else if (p.base.source.case === "templateId" && !UUID_RE.test(p.base.source.value)) {
      v.push({ field: "base.templateId", message: "template_id must be a UUID" });
    } else if (p.base.source.case === "snapshotId" && !UUID_RE.test(p.base.source.value)) {
      v.push({ field: "base.snapshotId", message: "snapshot_id must be a UUID" });
    }

    validatePath(p.workdir, "workdir", v, false, "workdir");

    if (p.context) {
      const git = p.context.source?.source.case === "git" ? p.context.source.source.value : undefined;
      if (!git) {
        v.push({ field: "context.source", message: "a Git context source is required" });
      } else {
        validateLength(git.repo, "context.source.git.repo", 1, 4096, v);
        validateLength(git.ref, "context.source.git.ref", 1, 1024, v);
      }
      const checkout = p.context.checkout;
      if (checkout) {
        validatePath(checkout.dest, "context.checkout.dest", v, false, "dest");
        if (checkout.name !== undefined && checkout.mode !== TemplateCheckoutMode.DIRECTORY) {
          v.push({ field: "context.checkout.name", message: "checkout name is only valid in directory mode" });
        }
        if (
          checkout.name !== undefined &&
          (checkout.name === "." ||
            checkout.name === ".." ||
            checkout.name.includes("/") ||
            checkout.name.length < 1 ||
            checkout.name.length > 255)
        ) {
          v.push({ field: "context.checkout.name", message: "checkout name must be a safe 1-255 character name" });
        }
      }
      if (p.context.ignore.length > 256) {
        v.push({ field: "context.ignore", message: "at most 256 ignore rules are supported" });
      }
      p.context.ignore.forEach((rule, i) => validateLength(rule, `context.ignore[${i}]`, 0, 4096, v));
    }

    if (p.build && Object.keys(p.build.env).length > 256) {
      v.push({ field: "build.env", message: "at most 256 build environment variables are supported" });
    }

    if (p.steps.length > 256) {
      v.push({ field: "steps", message: "at most 256 steps are supported" });
    }
    p.steps.forEach((step, i) => validateStep(step, i, p.context !== undefined, v));

    if (p.runtime) validateRuntime(p.runtime, v);

    if (p.resources) {
      const r = p.resources;
      if (r.cpuCores < 0 || r.cpuCores > 128) {
        v.push({ field: "resources.cpuCores", message: "cpu_cores must be between 0 and 128" });
      }
      if (r.memoryMb !== 0 && (r.memoryMb < 512 || r.memoryMb > 524288 || r.memoryMb % 2 !== 0)) {
        v.push({ field: "resources.memoryMb", message: "memory_mb must be 0 or an even value between 512 and 524288" });
      }
      if (r.diskSizeGb !== 0 && (r.diskSizeGb < 5 || r.diskSizeGb > 100)) {
        v.push({ field: "resources.diskSizeGb", message: "disk_size_gb must be 0 or between 5 and 100" });
      }
    }

    return v;
  }

  private update(mutate: (proto: ProtoTemplateBuildSpec) => void): TemplateSpec {
    const next = clone(TemplateBuildSpecSchema, this.proto);
    mutate(next);
    return TemplateSpec.fromProto(next);
  }

  private addStep(name: string | undefined, operation: TemplateStep["operation"]): TemplateSpec {
    return this.update((p) => {
      const step = create(TemplateStepSchema, { operation });
      if (name !== undefined) step.name = name;
      p.steps.push(step);
    });
  }

  private addPackageStep(
    manager: "apt" | "pip" | "npm" | "bun",
    packages: string[],
    options?: TemplateStepOptions,
  ): TemplateSpec {
    return this.addStep(options?.name, {
      case: manager,
      value: create(TemplatePackageStepSchema, { packages: [...packages] }),
    });
  }

  private setStart(init: { command?: string; argv?: string[] }, options?: TemplateStartOptions): TemplateSpec {
    return this.update((p) => {
      const runtime = ensureRuntime(p);
      runtime.entrypoint = {
        case: "start",
        value: create(TemplateStartRuntimeSchema, {
          command: init.command ?? "",
          argv: init.argv ?? [],
          workdir: options?.workdir ?? "",
        }),
      };
      applyRuntimeOptions(runtime, options);
    });
  }
}

function runStep(init: { command?: string; argv?: string[] }, options?: TemplateRunOptions): TemplateRunStep {
  return create(TemplateRunStepSchema, {
    command: init.command ?? "",
    argv: init.argv ?? [],
    workdir: options?.workdir ?? "",
    timeoutSeconds: options?.timeoutSeconds ?? 0,
  });
}

function ensureRuntime(p: ProtoTemplateBuildSpec): ProtoTemplateRuntime {
  p.runtime ??= create(TemplateRuntimeSchema, {});
  return p.runtime;
}

function applyRuntimeOptions(runtime: ProtoTemplateRuntime, options?: TemplateRuntimeOptions): void {
  if (!options) return;
  if (options.secretFiles !== undefined) runtime.secretFiles = options.secretFiles.map(secretFileToProto);
  if (options.secretRequests !== undefined) runtime.secretRequests = options.secretRequests.map(secretRequestToProto);
  if (options.secretEnv !== undefined) runtime.secretEnv = { ...options.secretEnv };
  if (options.runAt !== undefined) {
    runtime.runAt =
      options.runAt === "boot"
        ? TemplateRuntimeRunAt.BOOT
        : options.runAt === "build"
          ? TemplateRuntimeRunAt.BUILD
          : TemplateRuntimeRunAt.MANUAL;
  }
  if (options.restartPolicy !== undefined) {
    runtime.restartPolicy =
      options.restartPolicy === "never"
        ? TemplateRestartPolicy.NEVER
        : options.restartPolicy === "always"
          ? TemplateRestartPolicy.ALWAYS
          : TemplateRestartPolicy.ON_FAILURE;
  }
  if (options.snapshotMode !== undefined) {
    runtime.snapshotMode =
      options.snapshotMode === "memory" ? TemplateSnapshotMode.MEMORY : TemplateSnapshotMode.FILESYSTEM;
  }
  if (options.readyWhen !== undefined) {
    runtime.readyWhen = readyWhenToProto(options.readyWhen);
  }
  if (options.stopGraceSeconds !== undefined) {
    runtime.stopGraceSeconds = options.stopGraceSeconds;
  }
}

function readyWhenToProto(readyWhen: TemplateReadyCheck[] | TemplateReadyWhen): TemplateSnapshotWhen {
  const options: TemplateReadyWhen = Array.isArray(readyWhen) ? { checks: readyWhen } : readyWhen;
  return create(TemplateSnapshotWhenSchema, {
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS,
    pollIntervalSeconds: options.pollIntervalSeconds ?? 0,
    checks: (options.checks ?? []).map(readyCheckToProto),
  });
}

function readyCheckToProto(check: TemplateReadyCheck): TemplateSnapshotCheck {
  if ("port" in check) {
    return create(TemplateSnapshotCheckSchema, { check: { case: "port", value: check.port } });
  }
  if ("http" in check) {
    const http = typeof check.http === "string" ? { url: check.http } : check.http;
    return create(TemplateSnapshotCheckSchema, {
      check: {
        case: "http",
        value: create(TemplateHTTPReadyCheckSchema, {
          url: http.url,
          successStatusCodes: [...(http.successStatusCodes ?? [])],
        }),
      },
    });
  }
  const exec = typeof check.exec === "string" ? { command: check.exec } : check.exec;
  return create(TemplateSnapshotCheckSchema, {
    check: {
      case: "exec",
      value: create(TemplateExecReadyCheckSchema, {
        command: exec.command ?? "",
        argv: [...(exec.argv ?? [])],
        timeoutSeconds: exec.timeoutSeconds ?? 0,
      }),
    },
  });
}

function contextRelative(path: string): boolean {
  return path !== "" && !path.startsWith("/") && path.split("/").every((part) => part !== "..");
}

function validateLength(value: string, field: string, min: number, max: number, v: TemplateSpecViolation[]): void {
  if (value.length < min || value.length > max) {
    v.push({ field, message: `must be between ${min} and ${max} characters` });
  }
}

function validatePath(value: string, field: string, v: TemplateSpecViolation[], required = true, noun = "path"): void {
  if (required && value === "") {
    v.push({ field, message: `${noun} is required` });
    return;
  }
  if (value.length > MAX_PATH_LENGTH) {
    v.push({ field, message: `path must be at most ${MAX_PATH_LENGTH} characters` });
  }
  if (value !== "" && !value.startsWith("/")) {
    v.push({ field, message: `${noun} must be an absolute path` });
  }
}

function validateCommandOrArgv(
  value: { command: string; argv: string[] },
  field: string,
  v: TemplateSpecViolation[],
): void {
  if ((value.command !== "") === value.argv.length > 0) {
    v.push({ field, message: "exactly one of command or argv is required" });
  }
  if (value.command.length > 65536) {
    v.push({ field: `${field}.command`, message: "command must be at most 65536 characters" });
  }
  if (value.argv.length > 1024) {
    v.push({ field: `${field}.argv`, message: "argv must contain at most 1024 items" });
  }
  value.argv.forEach((arg, i) => {
    if (arg === "") v.push({ field: `${field}.argv[${i}]`, message: "argv entries must not be empty" });
  });
}

function validateStep(step: TemplateStep, index: number, hasContext: boolean, v: TemplateSpecViolation[]): void {
  const op = step.operation;
  const field = `steps[${index}].${op.case ?? ""}`;
  if (step.name !== undefined && (step.name.length < 1 || step.name.length > 128)) {
    v.push({ field: `steps[${index}].name`, message: "step name must be between 1 and 128 characters" });
  }
  switch (op.case) {
    case undefined:
      v.push({ field: `steps[${index}]`, message: "exactly one step operation is required" });
      return;
    case "run":
      validateCommandOrArgv(op.value, field, v);
      validatePath(op.value.workdir, `${field}.workdir`, v, false, "workdir");
      if (op.value.timeoutSeconds < 0 || op.value.timeoutSeconds > 86400) {
        v.push({ field: `${field}.timeoutSeconds`, message: "timeout_seconds must be between 0 and 86400" });
      }
      return;
    case "copy":
      if (!hasContext) {
        v.push({ field, message: "copy steps require a Git context" });
      }
      if (!contextRelative(op.value.src)) {
        v.push({ field: `${field}.src`, message: "src must be context-relative and cannot traverse above context" });
      }
      if (op.value.src.length > MAX_PATH_LENGTH) {
        v.push({ field: `${field}.src`, message: `src must be at most ${MAX_PATH_LENGTH} characters` });
      }
      validatePath(op.value.dest, `${field}.dest`, v, true, "dest");
      return;
    case "writeFile":
      validatePath(op.value.path, `${field}.path`, v);
      if (op.value.content.byteLength > 1048576) {
        v.push({ field: `${field}.content`, message: "content must be at most 1 MiB" });
      }
      if (op.value.mode !== undefined && (op.value.mode < 0 || op.value.mode > 4095)) {
        v.push({ field: `${field}.mode`, message: "mode must be between 0 and 4095" });
      }
      return;
    case "mkdir":
      validatePath(op.value.path, `${field}.path`, v);
      if (op.value.mode !== undefined && (op.value.mode < 0 || op.value.mode > 4095)) {
        v.push({ field: `${field}.mode`, message: "mode must be between 0 and 4095" });
      }
      return;
    case "remove":
      validatePath(op.value.path, `${field}.path`, v);
      return;
    case "rename":
      validatePath(op.value.src, `${field}.src`, v);
      validatePath(op.value.dest, `${field}.dest`, v);
      return;
    case "symlink":
      validateLength(op.value.target, `${field}.target`, 1, 4096, v);
      validatePath(op.value.path, `${field}.path`, v);
      return;
    case "apt":
    case "pip":
    case "npm":
    case "bun":
      if (op.value.packages.length === 0) {
        v.push({ field: `${field}.packages`, message: "at least one package is required" });
      } else if (op.value.packages.length > 1024) {
        v.push({ field: `${field}.packages`, message: "at most 1024 packages are supported" });
      }
      if (new Set(op.value.packages).size !== op.value.packages.length) {
        v.push({ field: `${field}.packages`, message: "packages must be unique" });
      }
      op.value.packages.forEach((pkg, i) => {
        if (!PACKAGE_RE.test(pkg)) {
          v.push({
            field: `${field}.packages[${i}]`,
            message: "package name must be non-empty and cannot start with -",
          });
        }
      });
      return;
  }
}

function validateRuntime(runtime: ProtoTemplateRuntime, v: TemplateSpecViolation[]): void {
  if (!validSecretFiles(runtime.secretFiles, Object.keys(runtime.secretEnv).length))
    v.push({ field: "runtime.secretFiles", message: "invalid secret file declaration" });
  if (Object.keys(runtime.secretEnv).length > 64)
    v.push({ field: "runtime.secretEnv", message: "at most 64 secret references are supported" });
  for (const [target, name] of Object.entries(runtime.secretEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(target))
      v.push({ field: "runtime.secretEnv", message: "invalid environment target" });
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name))
      v.push({ field: "runtime.secretEnv", message: "invalid workspace secret name" });
    if (Object.hasOwn(runtime.env, target))
      v.push({ field: "runtime.secretEnv", message: "secret target conflicts with runtime environment" });
  }
  if (Object.keys(runtime.env).length > 256) {
    v.push({ field: "runtime.env", message: "at most 256 runtime environment variables are supported" });
  }
  if (runtime.entrypoint.case === undefined) {
    v.push({ field: "runtime", message: "exactly one runtime entrypoint is required" });
  }
  if (runtime.entrypoint.case === "start") {
    validateCommandOrArgv(runtime.entrypoint.value, "runtime.start", v);
    validatePath(runtime.entrypoint.value.workdir, "runtime.start.workdir", v, false, "workdir");
  }
  if (runtime.entrypoint.case === "processCompose") {
    const pc = runtime.entrypoint.value;
    if (!contextRelative(pc.configPath)) {
      v.push({
        field: "runtime.processCompose.configPath",
        message: "config_path must be workdir-relative and cannot traverse above it",
      });
    }
    if (pc.configPath.length > MAX_PATH_LENGTH) {
      v.push({
        field: "runtime.processCompose.configPath",
        message: `config_path must be at most ${MAX_PATH_LENGTH} characters`,
      });
    }
    if (pc.envFiles.length > 32) {
      v.push({ field: "runtime.processCompose.envFiles", message: "at most 32 env_files are supported" });
    }
    if (new Set(pc.envFiles).size !== pc.envFiles.length) {
      v.push({ field: "runtime.processCompose.envFiles", message: "env_files must be unique" });
    }
    pc.envFiles.forEach((file, i) => {
      if (!contextRelative(file)) {
        v.push({
          field: `runtime.processCompose.envFiles[${i}]`,
          message: "env_files must be workdir-relative and cannot traverse above it",
        });
      }
      if (file.length > MAX_PATH_LENGTH) {
        v.push({
          field: `runtime.processCompose.envFiles[${i}]`,
          message: `env_file must be at most ${MAX_PATH_LENGTH} characters`,
        });
      }
    });
    validatePath(pc.workdir, "runtime.processCompose.workdir", v, false, "workdir");
  }
  if (runtime.runAt === TemplateRuntimeRunAt.BUILD && !runtime.readyWhen) {
    v.push({ field: "runtime.readyWhen", message: "build runtime requires ready_when" });
  }
  if (runtime.snapshotMode !== TemplateSnapshotMode.UNSPECIFIED && runtime.runAt !== TemplateRuntimeRunAt.BUILD) {
    v.push({ field: "runtime.snapshotMode", message: "snapshot_mode is only valid for build runtime" });
  }
  if (runtime.stopGraceSeconds < 0 || runtime.stopGraceSeconds > 300) {
    v.push({ field: "runtime.stopGraceSeconds", message: "stop_grace_seconds must be between 0 and 300" });
  }
  if (runtime.readyWhen) validateReadyWhen(runtime.readyWhen, "runtime.readyWhen", v);
}

function validateReadyWhen(readyWhen: TemplateSnapshotWhen, field: string, v: TemplateSpecViolation[]): void {
  if (readyWhen.timeoutSeconds < 1 || readyWhen.timeoutSeconds > 86400) {
    v.push({ field: `${field}.timeoutSeconds`, message: "timeout_seconds must be between 1 and 86400" });
  }
  if (readyWhen.pollIntervalSeconds < 0 || readyWhen.pollIntervalSeconds > 60) {
    v.push({ field: `${field}.pollIntervalSeconds`, message: "poll_interval_seconds must be between 0 and 60" });
  }
  if (readyWhen.checks.length > 64) {
    v.push({ field: `${field}.checks`, message: "at most 64 readiness checks are supported" });
  }
  readyWhen.checks.forEach((check, i) => {
    const checkField = `${field}.checks[${i}]`;
    switch (check.check.case) {
      case undefined:
        v.push({ field: checkField, message: "exactly one readiness check is required" });
        return;
      case "port":
        if (check.check.value < 1 || check.check.value > 65535) {
          v.push({ field: `${checkField}.port`, message: "port must be between 1 and 65535" });
        }
        return;
      case "http":
        if (check.check.value.url.length > MAX_PATH_LENGTH || !LOCALHOST_HTTP_RE.test(check.check.value.url)) {
          v.push({ field: `${checkField}.http.url`, message: "url must target localhost over http(s)" });
        }
        if (check.check.value.successStatusCodes.length > 100) {
          v.push({ field: `${checkField}.http.successStatusCodes`, message: "at most 100 status codes are supported" });
        }
        if (new Set(check.check.value.successStatusCodes).size !== check.check.value.successStatusCodes.length) {
          v.push({ field: `${checkField}.http.successStatusCodes`, message: "status codes must be unique" });
        }
        check.check.value.successStatusCodes.forEach((code, codeIndex) => {
          if (code < 100 || code > 599) {
            v.push({
              field: `${checkField}.http.successStatusCodes[${codeIndex}]`,
              message: "status code must be between 100 and 599",
            });
          }
        });
        return;
      case "exec":
        validateCommandOrArgv(check.check.value, `${checkField}.exec`, v);
        if (check.check.value.timeoutSeconds < 0 || check.check.value.timeoutSeconds > 300) {
          v.push({ field: `${checkField}.exec.timeoutSeconds`, message: "timeout_seconds must be between 0 and 300" });
        }
        return;
    }
  });
}

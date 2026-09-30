# @tenkicloud/sandbox

TypeScript SDK for [Tenki Sandbox](https://tenki.cloud), programmatic cloud sandboxes for AI agents.

## Install

```bash
npm install @tenkicloud/sandbox
```

Requires Node.js 18 or newer. Bun 1.3 or newer also works.

## Quick Start

```typescript
import { TenkiSandbox } from "@tenkicloud/sandbox";

const sandbox = new TenkiSandbox(); // reads TENKI_AUTH_TOKEN
// create() waits by default via a single server-held request and returns a
// run-ready sandbox with data-plane access primed.
const session = await sandbox.create({
  cpuCores: 2,
  memoryMb: 4096,
});

try {
  const result = await session.run(["echo", "hello"]);
  console.log(result.exitCode); // 0
} finally {
  await session.close();
}
```

`Session` also implements `AsyncDisposable`, so `await using` works in runtimes that support explicit resource management.

### Tailnet attachment

Use `TailnetAuthKey` so string, JSON, and Node debug formatting redact the credential.
`waitForOnline` keeps the session in creation until Tenki verifies the registered node.

```typescript
import { TailnetAuthKey, TenkiSandbox } from "@tenkicloud/sandbox";

const session = await new TenkiSandbox().create({
  tailnet: {
    authKey: new TailnetAuthKey(process.env.TAILNET_AUTH_KEY!),
    tags: ["tag:sandbox"],
    exposePorts: [3000],
    acceptRoutes: true,
    waitForOnline: true,
  },
});
console.log(session.tailnetStatus?.state, session.tailnetStatus?.fqdn);
```

The direct key is write-only and never appears on `Session`.
The server may reject options from later milestones, including wake-on-connect and recreate-on-resume.

## Authentication

Pass an API key or service token starting with `tk_` explicitly, or set `TENKI_AUTH_TOKEN` or `TENKI_API_KEY`:

```typescript
const sandbox = new TenkiSandbox({ authToken: "tk_..." });
```

`apiKey` is an alias for `authToken`. If both are supplied, `authToken` wins.
Blank or whitespace-only values count as absent.

The credential determines the Workspace automatically; ordinary Sandbox calls do not require a Workspace ID.

### Migrating to v0.7.0

Version 0.7.0 removes the generated workspace settings and pause-retention RPCs.
Use `getUsage()` for read-only workspace usage and limit data. Its shared
concurrency entry now uses the `max_concurrent_jobs` key.

### Migrating to v0.6.0

Version 0.6.0 removes `ClientOptions.cookieName` and support for Ory session
tokens and browser cookie values. Pass a `tk_` API key or service token through
`authToken`; the SDK sends it as an `Authorization: Bearer` credential.

## Sessions

```typescript
const session = await sandbox.create({
  name: "my-sandbox",
  cpuCores: 4,
  memoryMb: 8192,
  diskSizeGb: 10,
  allowInbound: true,
  allowOutbound: true,
  env: { NODE_ENV: "production" },
  metadata: { purpose: "ci" },
  tags: ["ci"],
  cloneRepoUrl: "https://github.com/org/repo",
  githubToken: process.env.GITHUB_TOKEN,
  sticky: true,
});

await session.refresh();
await session.extend(10 * 60 * 1000);
await session.update({ name: "renamed", tags: ["ci", "kept"] });
await session.pause();
await session.resume();
await session.close();
```

`idleTimeoutMinutes` is deprecated and ignored: sandboxes do not auto-pause on
idle. Use `maxDurationMs`, or `session.pause()` to pause explicitly.

`sticky: true` discards `maxDurationMs` and runs the session until it is
terminated. Manual pause and resume do not clear sticky. The returned
`session.warnings` array retains the structured warning. By default,
`TenkiSandbox` writes each warning to `console.warn`. Set `warningHandler` to
route warnings through your logger, or pass `null` to suppress emission:

```typescript
const sandbox = new TenkiSandbox({
  warningHandler: (warning) => process.emitWarning(warning.message),
});

const session = await sandbox.create({ sticky: true, maxDurationMs: 60 * 60 * 1000 });
if (session.warnings[0]?.code === "STICKY_OVERRIDES_MAX_DURATION") {
  console.log("maxDurationMs was discarded");
}
```

Create from an image or snapshot:

```typescript
await sandbox.create({ image: "workspace/name:tag" });
await sandbox.create({ snapshotId: "snap_..." });
```

### Durable pause

`pauseAsync()` returns after the service durably accepts the request and moves the session to `PAUSING` on a node that supports asynchronous pause.
Snapshot capture and persistence continue in the background; acceptance does not mean the VM has stopped or the snapshot is durable.
`pause()` retains its existing completion behavior for compatibility.
Call `waitPaused()` before resuming or relying on a durable checkpoint.
It resolves at `PAUSED` and throws `PauseFailedError` if a verified rollback restores `RUNNING`.
Pass `0` as `timeoutMs` to wait until an abort signal cancels the call.

`DURABLE_CEPH` snapshots can resume on a capability-matched host in the same datacenter while R2 replication continues.
`DURABLE` snapshots are portable to eligible hosts.
`LOCAL_READY` is not resumable for pause operations.

### What survives a pause

Pause captures the VM's full memory, not only its disk: a resumed session is the
same running machine, not a reboot. Processes keep their PIDs and their in-memory
state, and the guest clock stops for the duration of the pause.

`/tmp` is cleared across a pause. Keep durable state under `/home/tenki`, which
is preserved.

While a session is paused it serves no traffic: preview requests return `404`
until it resumes. The client connection itself is not dropped — a held
keep-alive connection returns `200` again after resume — so treat a paused
session as unavailable rather than disconnected.

SSH is different: a held transport fails on use while paused and does not
recover after resume, so reconnect rather than retry on it. A fresh
connection succeeds as soon as the session is `RUNNING` again.

```typescript
async function text(cmd: string): Promise<string> {
  const result = await session.exec(["bash", "-lc", cmd]);
  return new TextDecoder().decode(result.stdout).trim();
}

await text("echo hello > ~/marker");
await text("setsid nohup sleep 3600 >/dev/null 2>&1 </dev/null &");
const pid = await text("pgrep -n sleep");

await session.pause();
await session.resume();

console.log(await text("cat ~/marker")); // "hello" - the marker file survived
console.log(await text(`kill -0 ${pid} && echo alive`)); // "alive" - same process, same memory
```

## Commands

```typescript
const proc = session.run(["npm", "test"], { cwd: "app", env: { CI: "true" } });

const reader = proc.stdout.getReader();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(value);
  }
} finally {
  reader.releaseLock();
}

const result = await proc;
console.log(result.exitCode);
```

`exec` takes argv either as a command plus `options.args` or as a single array:

```typescript
await session.exec("sh", { args: ["-c", "echo hi"] });
await session.exec(["sh", "-c", "echo hi"]); // equivalent
```

For simple commands, you can await `run` directly:

```typescript
const result = await session.run(["echo", "hello"]);
console.log(new TextDecoder().decode(result.stdout));
```

Process `cwd` values follow the guest contract: relative paths are normalized
under the sandbox guest workdir (`/home/tenki` by default), absolute paths are
used unchanged, and missing or non-directory targets fail before the process
starts.

`cwd` sets the spawned process's directory. A login shell (`bash -lc`) sources
the guest's startup files first, so a `cd` in `~/.bashrc` or `~/.profile` runs
before your command and wins over `cwd`; use `bash -c` when the directory must
hold.

### Timeouts and cancellation

Commands are unbounded by default. Pass `timeoutMs` for a budget, or a `signal`
to cancel.

The budget is enforced by the guest-agent, which signals the process on expiry
(`SIGTERM`, escalating to `SIGKILL`) and reports the run as timed out. That is
**not** an exception — it resolves with `status: "TIMED_OUT"`, carrying the output
captured before the budget expired:

```typescript
const result = await session.exec("bash", { args: ["-lc", "npm ci"], timeoutMs: 120_000 });
if (result.status === "TIMED_OUT") {
  // result.reason is "timeout", or "grace_timeout" when the guest could not reap
  // the process. Partial output usually shows where it stalled.
  console.error(result.reason, new TextDecoder().decode(result.stdout));
}
```

Aborting **is** an exception — the call rejects with the signal's reason:

```typescript
const controller = new AbortController();
const pending = session.exec("bash", { args: ["-lc", "make build"], signal: controller.signal });
controller.abort();
```

The guest caps the request at its own configured maximum command timeout, and
older guest-agents accept `timeoutMs` but ignore it, leaving the run unbounded.

### Background processes and long-running services

A command returns when its **stdout and stderr reach EOF**, not when the shell
exits. A backgrounded process inherits both streams and holds them open, so this
waits for the server rather than the shell:

```typescript
// Hangs: the server inherits stdout/stderr.
await session.exec("sh", { args: ["-lc", "python3 -m http.server 3000 &"] });
```

Redirect **both** streams to detach it:

```typescript
await session.exec("sh", { args: ["-lc", "python3 -m http.server 3000 >/home/tenki/http.log 2>&1 &"] });
```

Redirecting only stdout is not enough — stderr still holds the stream open — and
`nohup` does not help, because it blocks `SIGHUP` rather than stream inheritance.
This is standard POSIX behavior, the same as Node's own `child_process.exec`.

To keep hold of a service instead, use `session.run()` and read from the handle
rather than awaiting it; for services you always want running, start them from a
template `startCmd` instead.

That last option is the durable one. Every exec child runs inside the
guest-agent's own systemd cgroup, so a guest-agent restart kills it, and `nohup`
does not change that. Pause and resume restore VM memory, so a backgrounded
process does survive a pause with the same PID — which makes an ad-hoc service
look more durable than it is. Anything load-bearing belongs in a template start
command with a readiness probe.

### Stopping a process

`signal()` and `kill()` enqueue a signal frame and resolve immediately — they do
**not** wait for the process to die, matching Node's `child_process.kill()`.
Awaiting the handle is what resolves once the process has actually exited:

```typescript
const proc = session.run(["sleep", "3600"]);
await proc.signal("SIGTERM"); // resolves once the frame is queued
const result = await proc; // resolves once the process has exited
console.log(result.signal); // "terminated"
```

`result.signal` carries the guest's own name for the signal, not the name you
passed: SIGTERM reports `"terminated"` and SIGKILL reports `"killed"`. Compare
against those values, not against `"TERM"`/`"KILL"`.

Signalling before the guest acknowledges the spawn is safe: the SDK may still be
retrying the stream open, and a signal queued during that window is replayed onto
the replacement stream rather than being dropped.

`kill()` takes no argument and always sends SIGKILL; use `signal(name)` for
anything else. Only `KILL`, `TERM`, `INT`, `HUP`, `USR1` and `USR2` are
supported (with or without the `SIG` prefix), and **any unrecognized name is
silently sent as SIGTERM** — a typo like `signal("SIGTRM")` stops the process
gracefully instead of throwing, and so does `signal("unspecified")`, which is a
harmless no-op in the Python SDK. (Python raises `ValueError` for unknown names
instead.) Signalling a process that has already exited is a no-op, not an error,
so the result of `signal()`/`kill()` is best-effort by design.

Process lifetime is bound to the Run stream, not to the handle. Once that stream
tears down — the connection breaks, or the edge times the idle connection out
(~30s) — the platform sends SIGTERM, escalates to SIGKILL after 5s if the process
is still alive, and reaps it within 10s.

Dropping the handle does **not** close the stream on its own: the outbound queue
is closed only once the result settles. An abandoned process can keep running,
and one that keeps writing output keeps its own stream alive indefinitely. To
stop a process, signal it and await the handle rather than abandoning it. There
is no reattach — a caller that loses the handle must respawn.

## Files

Simple helpers:

```typescript
await session.writeFile("/tmp/config.json", '{"key":"value"}');
const data = await session.readFile("/tmp/config.json");
console.log(new TextDecoder().decode(data));
```

Filesystem API:

```typescript
await session.fs.mkdir("/tmp/example");
await session.fs.stat("/tmp/example");
const entries = await session.fs.list("/tmp");
await session.fs.remove("/tmp/example");
```

### Disk space

The root disk defaults to 5 GB and holds the base image as well as your work, so a fresh
sandbox already reports around 56% used. It is fixed at create time and cannot be grown in
place — pass `diskSizeGb` (5–100) to `create` if you need more. Budget for it before a
large install.

Every `ExecResult` carries `disk`. `isDiskExhausted(result.disk)` reports whether the
sandbox ran out of space at any point during the command — check it even when the command
exited 0, since npm reports `ENOSPC` as a warning and still exits successfully with a
broken install.

## Networking

`allowInbound` and `allowOutbound` both default to `true`, so a session reaches the internet and can expose
ports without passing either option. They are create-time settings and cannot be changed on an existing
session; `session.inboundEnabled` / `session.outboundEnabled` report what a session was created with.

### Egress allowlist

Restrict outbound access with `allowDomains` and `allowCidrs`. A session that may only reach PyPI:

```typescript
const session = await client.create({
  allowDomains: ["pypi.org", "*.pypi.org", "files.pythonhosted.org"],
});
```

`allowOutbound: false` still blocks everything, regardless of `allowDomains`/`allowCidrs`.
Read the allowlist back from `session.egress`.

Expose a sandbox port:

```typescript
const port = await session.exposePort(3000, { ttlMs: 60 * 60 * 1000, slug: "my-preview" });
console.log(port.previewUrl);

const ports = await session.listExposedPorts();
await session.unexposePort(3000);
```

Dial from your program into the sandbox:

```typescript
const conn = await session.dial("/var/run/docker.sock");
// conn has Web Streams: { readable, writable }.
```

Expose a local host port to the sandbox:

```typescript
const tunnel = await session.resilientHostPortTunnel("127.0.0.1", 3000, {
  sandboxPort: 8080,
});

const [address, port] = tunnel.endpoint();
await tunnel.close();
```

## Git

```typescript
await session.git.clone("https://github.com/org/repo", { depth: 1, directory: "/home/tenki/repo" });
await session.git.checkout("feature-branch");
const diff = await session.git.diff({ base: "main", head: "HEAD" });
const log = await session.git.log({ maxCount: 10 });
await session.git.fetchPR(42, { remote: "origin", directory: "/home/tenki/repo" });
```

## Snapshots

```typescript
const snapshot = await sandbox.createSnapshotAndWait(session.id, {
  name: "after-setup",
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
});

const restored = await sandbox.create({ snapshotId: snapshot.id });
```

## Registry

```typescript
const published = await sandbox.publishRegistryImage({
  fromSnapshotId: snapshot.id,
  workspaceId: "ws_...",
  name: "my-image",
  tag: "latest",
  visibility: "private",
});

const resolved = await sandbox.resolveRegistryRef("my-image:latest");
const next = await sandbox.create({ image: resolved.resolvedRef });

// Only untagged, non-latest, unshared versions can be deleted.
await sandbox.deleteRegistryImageVersion(
  "01900000-0000-7000-8000-000000000001",
  "01900000-0000-7000-8000-000000000002",
);
```

## Templates

Templates are typed, immutable recipes built from a Git context into private digest-addressed images. `TemplateSpec` is a fluent immutable builder: every method returns a new spec, the default base is the Tenki image `sandbox`, and `copy` sources are always relative to the checked-out Git context - nothing is uploaded from your local filesystem.

```typescript
import { TemplateSpec } from "@tenkicloud/sandbox";

const spec = new TemplateSpec()
  .fromImage("sandbox-v2") // or .fromTemplate(parent) / .fromSnapshot(snapshot)
  .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
  .workdir("/home/tenki/app")
  .run("npm ci", { name: "Install dependencies" })
  .runtimeEnv({ NODE_ENV: "production" })
  .startArgs(["npm", "start"], {
    runAt: "boot",
    readyWhen: [{ http: "http://localhost:3000/health" }],
  });

const violations = spec.validate(); // local [{ field, message }]; the server stays authoritative

const template = await sandbox.createTemplate({
  name: "node-api",
  spec,
});
```

Build it, observing ordered log/progress events. Build secrets are explicit request-time values: they never land in the template, spec hash, provenance, or logs. Interrupting the observer (handler error, AbortSignal, Ctrl-C) stops watching only; cancelling the remote build is always explicit via `cancelTemplateBuild`.

```typescript
const build = await sandbox.buildTemplate(template, {
  buildSecrets: { GITHUB_TOKEN: token },
  waitForCompletion: true,
  onEvent(event) {
    // Discriminated union, delivered in order; async handlers are awaited sequentially.
    if (event.type === "log") process.stdout.write(event.data);
    else console.log(`[${event.phase}] ${event.state}`, event.step?.label);
  },
});

console.log(build.specHash, build.image?.digestRef); // e.g. acme/node-api@sha256:...
```

A waited build failure throws `TemplateBuildFailedError` carrying the final build. `waitForTemplateBuild(build)` reconnects to an in-flight build with the same ordered, deduplicated event delivery.

Launch sandboxes from the built image. `waitForRuntime: true` also waits for the declared runtime to become READY; runtime failure leaves the sandbox RUNNING and throws `TemplateRuntimeFailedError` carrying the session and redacted failure.

```typescript
const session = await sandbox.create({ image: build.image, waitForRuntime: true });
```

Filesystem snapshots (the default) capture the built filesystem and start the runtime on boot. `snapshotMode: "memory"` (with `runAt: "build"` and a `readyWhen` deadline) captures the running process for near-instant restore; when memory restore is unavailable or incompatible the platform cold-boots the same image rootfs, starts the declared runtime, and waits on the same `readyWhen` contract - never silently falling back to a clean base image.

```typescript
const memorySpec = new TemplateSpec()
  .withGitContext({ repo: "https://github.com/acme/node-api", ref: "main" })
  .run("npm ci")
  .startArgs(["npm", "run", "dev"], {
    runAt: "build",
    snapshotMode: "memory",
    readyWhen: { timeoutSeconds: 60, checks: [{ port: 3000 }] },
  });
```

Specs round-trip through strict authored JSON with `JSON.stringify(spec)` / `TemplateSpec.fromJSON(json)`. Enum fields use short lowercase values: checkout `mode` is `"contents"` or `"directory"`; runtime `runAt`, `restartPolicy`, and `snapshotMode` use values such as `"build"`, `"on-failure"`, and `"memory"`. Existing full protobuf enum names remain accepted, unknown fields are rejected, and the canonical spec hash is computed server-side only.

## SSH

Use `session.run()` for normal command execution. `session.ssh()` is a low-level,
bidirectional byte transport for SSH protocol implementations that accept a
custom stream. It does not open a shell or execute command text itself.

A custom SSH integration needs a caller-owned key pair; the private key stays
with your application. Pass the public key in OpenSSH `authorized_keys` format
to Tenki, then authenticate the SSH client with the matching private key and
returned certificate. The minimal SDK sequence is:

```typescript
const credentials = await sandbox.issueSandboxSSHCert(session.id, publicKey);
const transport = await session.ssh();
try {
  // Adapt transport.read(), write(), and close() to your SSH client.
  // Authenticate with the matching private key and credentials.sshCert.
} finally {
  transport.close();
}
```

`credentials.expiresAt` is the absolute certificate expiry.
`credentials.renewalAfterMs` is an optional elapsed-time hint for minting a new
certificate before opening a later connection. `credentials.permissions`
reports the SSH features allowed for the certificate.

For OpenSSH, save `credentials.sshCert` beside the private key as
`<key>-cert.pub`, or pass it with `CertificateFile`. OpenSSH cannot consume
`session.ssh()` directly because the SDK transport is not a TCP socket; it
requires a transport adapter such as a ProxyCommand.

Gateway selection is automatic. Most users should not set `gatewayAddress` or
`TENKI_SANDBOX_GATEWAY_URL`; they are advanced overrides for environments with
a custom SSH gateway address. Setting either disables automatic selection.
`sshAuthorizedKeys` installs public keys inside the sandbox, but connections
through Tenki's SSH gateway also require a short-lived certificate from
`issueSandboxSSHCert`.

## Identity

```typescript
const me = await sandbox.whoAmI();
console.log(
  me.ownerId,
  me.workspaces.map((w) => w.id),
);
```

## Error Handling

All SDK errors extend `SandboxError`:

```typescript
import { SandboxError } from "@tenkicloud/sandbox";

try {
  await session.run(["false"]);
} catch (err) {
  if (err instanceof SandboxError) {
    console.error(err.message);
  }
}
```

## Size Constants

```typescript
import { GB, GiB, KB, KiB, MB, MiB, TB, TiB } from "@tenkicloud/sandbox";
```

## Workspace secrets

`WorkspaceClient` exposes workspace resources through `workspace.secrets`, independently of sandbox Sessions:

```typescript
import { WorkspaceClient } from "@tenkicloud/sandbox";

await using workspace = new WorkspaceClient({ workspaceId });
const secret = await workspace.secrets.create("TOKEN", valueBytes, requestId);
```

Authentication uses `TENKI_AUTH_TOKEN` or `TENKI_API_KEY`. Set `baseUrl` or
`TENKI_CLOUD_API_URL` to override the cloud API endpoint independently of sandbox
configuration. Set `workspaceId` once on the client. An omitted or empty workspace ID uses the authenticated workspace key's scope;
other callers must specify one.

`create`, `update`, `get`, `list`, `listVersions`, `revoke`, and `delete` return
metadata only. Values are `Uint8Array`; omitting `value` on update retains it, while
an empty array creates an empty value. Update, revoke, and delete require
`expectedRevision`. To select an existing version, update `activeVersion` with
`value` omitted. Revoking without `version` revokes every version. Revoking the active version revokes
the secret until a new value or an unrevoked version is made active.

Mutations generate a request ID when none is supplied. For retries after an
uncertain result, supply and reuse the same request ID and identical arguments.
The SDK does not retry mutations automatically. `WorkspaceSecretError.code`
preserves the RPC status, including revision conflicts.

Workspace secrets can be referenced by a managed runtime without passing their values:

```typescript
const runtime = new TemplateSpec().start("npm start", {
  secretEnv: { API_TOKEN: "app-token" },
});
const session = await sandbox.create({
  image: "team/base:v1",
  directRuntime: runtime,
  secretOverrides: { "app-token": "development-token" },
});
```

The same `secretEnv` option works with `startArgs` and `processCompose` in stored
templates. Names resolve in the launching workspace. `directRuntime` accepts a
runtime-only `TemplateSpec` and starts at boot; use create options for the image
and resources. Secret targets cannot also appear in ordinary runtime/session env.
`session.hasRuntimeSecrets` and `snapshot.hasRuntimeSecrets` are read-only markers.

## Runtime secret files

Put `secrets://API_TOKEN` in any text file, regardless of filename or extension. Built templates capture unresolved source text from the guest image; direct launches supply content read on the caller. Values resolve from the launching workspace before managed startup.

```typescript
import { readFile } from "node:fs/promises";

// Built template: source is already inside the image.
const spec = new TemplateSpec().start("python3 /app/server.py", {
  secretFiles: [{ source: "/app/env.tpl-sandbox", path: "/app/.env" }],
});

// Direct launch: read on the caller and upload unresolved text.
const session = await client.create({
  image: "my-template:latest",
  secretFiles: [{ path: "/app/.env", content: await readFile("./env.tpl-sandbox", "utf8") }],
  secretOverrides: { API_TOKEN: "STAGING_API_TOKEN" },
});
```

Rendering performs one literal pass, without YAML/JSON/dotenv escaping, environment expansion, or recursive substitution. A backslash before a marker escapes it. Authors must ensure the actual consumer accepts the result; do not shell-source rendered secret text. Use a raw reference for exact-byte credentials, including binary values.

Allowed destinations are under `/home/tenki/`, `/workspace/`, or `/app/`. Files are private, owned by tenki, and replaced atomically. Duplicate destinations, unsafe paths, and missing references fail startup. Limits: 64 KiB per secret, 256 KiB per source/output file, 1 MiB total source/output, 32 files, and 64 references across environment and files.

Guest values remain frozen across retries, restart, and ordinary resume; replacement Sessions adopt updates. Escape a file marker as `\secrets://NAME` to preserve `secrets://NAME` for separately authorized outbound injection; the marker grants no authority by itself. See [the file delivery contract](../../../docs/sandbox-secret-files.md) for lifecycle and path details.

## Transparent HTTPS secrets

Create `API_TOKEN` through the workspace Secrets client, then save and select a request policy:

```typescript
await workspaceClient.secrets.policies.create("example", [
  {
    origin: "https://api.example.com",
    methods: ["POST"],
    pathPrefix: "/v1/",
    header: "Authorization",
    secrets: ["API_TOKEN"],
  },
]);
const sandbox = await client.create({ secretPolicies: ["example"] });
```

Use `secretPolicies` in template `start`, `startArgs`, or `processCompose` options for required policies.

Send `Authorization: Bearer secrets://API_TOKEN` from the sandbox. The reference uses the actual secret name. No alias or injection override is required. Rules can instead select a `queryParameter` or `jsonPointer`, with one location per rule and one or more names in `secrets`.

Policies belong to a workspace and apply only to sessions that select them. Template-required names resolve in the launching workspace; explicit selections add to them. Policy edits and deletion affect subsequent requests on attached sessions. Rotation uses the active value, and revoked or deleted secrets are denied. Deleting and recreating a name does not retarget existing bindings.

Every referenced location must match a selected policy before the request is forwarded. Existing egress rules still apply. An unavailable resolver fails closed. Ordinary values and absent fields remain unchanged.

HTTPS interception requires a capable node and guest trust in the managed CA. Permit only trusted origins and paths: an upstream that echoes credentials can expose a value to the guest. See the [workspace secrets guide](../../../docs/src/product/workspace-secrets.md) for location limits and lifecycle behavior.

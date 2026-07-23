# @tenkicloud/sandbox

TypeScript SDK for [Tenki Sandbox](https://tenki.cloud), programmatic cloud sandboxes for AI agents.

## Install

```bash
npm install @tenkicloud/sandbox
```

Requires Node.js 18 or newer.

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

## Authentication

Pass a token explicitly or set `TENKI_AUTH_TOKEN`:

```typescript
const sandbox = new TenkiSandbox({ authToken: "tk_..." });
```

The API key determines the Workspace automatically; ordinary Sandbox calls do not require a Workspace ID.

## Sessions

```typescript
const session = await sandbox.create({
  name: "my-sandbox",
  cpuCores: 4,
  memoryMb: 8192,
  diskSizeGb: 10,
  allowInbound: true,
  allowOutbound: true,
  maxDurationMs: 60 * 60 * 1000,
  idleTimeoutMinutes: 15,
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

Create from an image or snapshot:

```typescript
await sandbox.create({ image: "workspace/name:tag" });
await sandbox.create({ snapshotId: "snap_..." });
```

## Commands

```typescript
const proc = session.run(["npm", "test"], { cwd: "project", env: { CI: "true" } });

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

For simple commands, you can await `run` directly:

```typescript
const result = await session.run(["echo", "hello"]);
console.log(new TextDecoder().decode(result.stdout));
```

Process `cwd` values follow the guest contract: relative paths are normalized
under the sandbox guest workdir (`/home/tenki` by default), absolute paths are
used unchanged, and missing or non-directory targets fail before the process
starts.

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

## Networking

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

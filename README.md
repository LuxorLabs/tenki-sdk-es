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
const proc = session.run(["npm", "test"], { env: { CI: "true" } });

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
```

## SSH

```typescript
const conn = await session.ssh();
try {
  await conn.write(new TextEncoder().encode("ls -la\n"));
  const data = await conn.read();
  if (data) process.stdout.write(data);
} finally {
  conn.close();
}
```

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

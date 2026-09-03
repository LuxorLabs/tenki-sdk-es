/**
 * Live argv checks against a real guest (CLO-4671). Opt-in.
 *
 * The unit tests in `test/argv-normalization.test.ts` assert on the start frame,
 * which proves what the SDK puts on the wire but not what the guest does with
 * it. These run the same argv shapes against a real sandbox, so they are what to
 * reach for when debugging argv handling end to end.
 *
 * Disabled by default. To run against local development:
 *
 *   export SANDBOX_E2E=1
 *   export TENKI_API_URL=http://localhost:8090     # 8090, and http:// is REQUIRED
 *   export TENKI_AUTH_TOKEN=tk_...                 # or TENKI_API_KEY
 *   npx vitest run test/e2e/argv.test.ts
 *
 * The scheme is not optional: a bare `localhost:8090` is not a valid URL here,
 * and an `https://` loopback URL dials TLS against a plaintext port. Note also
 * that TENKI_API_ENDPOINT outranks TENKI_API_URL, so a stale endpoint silently
 * wins over the URL you just set. The port matters too: the sandbox engine
 * serves SandboxService on :8090 (backend/configs/sandbox-engine.yaml), while
 * :8080 is traefik and answers 404. `beforeAll` checks all three before creating
 * anything, so a misconfiguration fails immediately with the fix in the message.
 *
 * Optional overrides: TENKI_SANDBOX_E2E_CPU_CORES (default 1),
 * TENKI_SANDBOX_E2E_MEMORY_MB (default 1024), TENKI_SANDBOX_E2E_TIMEOUT
 * (per-command seconds, default 60).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenkiSandbox } from "../../src/client.js";
import { DEFAULT_BASE_URL, ENV_API_ENDPOINT, ENV_API_URL } from "../../src/constants.js";
import { stderrText, stdoutText } from "../../src/result.js";
import type { Session } from "../../src/session.js";

const liveDescribe = process.env.SANDBOX_E2E === "1" ? describe : describe.skip;

function envInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  return value ? Number(value) : fallback;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Fail fast on the endpoint mistakes that otherwise surface as opaque TLS errors. */
function checkEndpoint(): string {
  const fromEndpoint = process.env[ENV_API_ENDPOINT]?.trim();
  const fromUrl = process.env[ENV_API_URL]?.trim();
  const baseUrl = fromEndpoint || fromUrl || DEFAULT_BASE_URL;
  const source = fromEndpoint ? ENV_API_ENDPOINT : fromUrl ? ENV_API_URL : "(default)";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      `${source}=${JSON.stringify(baseUrl)} is not a URL; include the scheme, e.g. http://localhost:8080`,
    );
  }
  // new URL("localhost:8080") does not throw -- it parses as protocol
  // "localhost:" with an empty hostname -- so check the scheme explicitly.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${source}=${JSON.stringify(baseUrl)} has no http(s) scheme (parsed protocol ${JSON.stringify(parsed.protocol)}); ` +
        `set ${source}=http://${baseUrl} instead.`,
    );
  }
  if (parsed.protocol === "https:" && LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `${source}=${JSON.stringify(baseUrl)} dials TLS at ${parsed.host}, but local development serves plaintext. ` +
        `Set ${source}=http://${parsed.host} instead.`,
    );
  }
  return baseUrl;
}

/** A 404 means the port answers HTTP but does not mount SandboxService. */
async function checkServiceRoute(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/+$/, "")}/tenki.sandbox.v1.SandboxService/ListSessions`;
  let status: number;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    status = response.status;
  } catch {
    // Unreachable is create()'s story to tell, with its own error mapping.
    return;
  }
  if (status === 404) {
    throw new Error(
      `${baseUrl} answers HTTP but serves no SandboxService route (404). In local development ` +
        `the sandbox engine listens on :8090 (backend/configs/sandbox-engine.yaml); :8080 is ` +
        `traefik, which has no route for it.`,
    );
  }
}

const COMMAND_TIMEOUT_MS = envInt("TENKI_SANDBOX_E2E_TIMEOUT", 60) * 1000;
// Creating the sandbox dominates; give the hook far more than one command needs.
const SETUP_TIMEOUT_MS = COMMAND_TIMEOUT_MS * 5;

liveDescribe("argv handling against a live guest", () => {
  let session: Session;

  beforeAll(async () => {
    if (!process.env.TENKI_AUTH_TOKEN?.trim() && !process.env.TENKI_API_KEY?.trim()) {
      throw new Error("TENKI_AUTH_TOKEN or TENKI_API_KEY is required");
    }
    await checkServiceRoute(checkEndpoint());
    const sandbox = new TenkiSandbox();
    // One session for the whole file; argv handling needs no isolation.
    session = await sandbox.create({
      cpuCores: envInt("TENKI_SANDBOX_E2E_CPU_CORES", 1),
      memoryMb: envInt("TENKI_SANDBOX_E2E_MEMORY_MB", 1024),
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await session?.close();
  }, SETUP_TIMEOUT_MS);

  const exec = (command: string | string[], args?: string[]) =>
    session.exec(command, { args, timeoutMs: COMMAND_TIMEOUT_MS });

  it("runs a command given as a single array", async () => {
    // The exact call from the ticket: it used to ENOENT with empty stdout.
    const result = await exec(["sh", "-c", "echo hi"]);
    expect(result.exitCode).toBe(0);
    expect(stdoutText(result).trim()).toBe("hi");
    expect([result.command, ...result.args]).toEqual(["sh", "-c", "echo hi"]);
  });

  it("treats the array form and the command + args form as equivalent", async () => {
    const asArray = await exec(["sh", "-c", "echo hi"]);
    const asArgs = await exec("sh", ["-c", "echo hi"]);
    expect([asArray.command, ...asArray.args]).toEqual([asArgs.command, ...asArgs.args]);
    expect(stdoutText(asArray)).toBe(stdoutText(asArgs));
    expect(asArray.exitCode).toBe(0);
    expect(asArgs.exitCode).toBe(0);
  });

  it("never shell-splits an argv part", async () => {
    // A part with spaces is one argument, so $# is 1 and $1 keeps the spaces.
    const result = await exec(["sh", "-c", 'printf "%s|%s" "$#" "$1"', "sh", "a b c"]);
    expect(result.exitCode).toBe(0);
    expect(stdoutText(result)).toBe("1|a b c");
  });

  it("reports exit code and stderr through the array form", async () => {
    const result = await exec(["sh", "-c", "echo oops >&2; exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(stderrText(result)).toContain("oops");
  });

  it("makes a missing binary diagnosable rather than silent", async () => {
    const result = await exec(["tenki-not-a-real-binary"]);
    // Something has to say why: a non-zero exit, a failed status, or a reason.
    const diagnosable = result.exitCode !== 0 || result.status === "FAILED" || Boolean(result.reason);
    expect(
      diagnosable,
      `a command that never started reported nothing: exitCode=${result.exitCode} status=${result.status} reason=${result.reason}`,
    ).toBe(true);
  });

  it("rejects a container argv part before reaching the guest", async () => {
    await expect(exec("sh", ["-c", ["echo", "hi"] as never])).rejects.toThrow(TypeError);
  });

  it("coerces a scalar argv part instead of rejecting it", async () => {
    const result = await exec("sleep", [0 as never]);
    expect(result.exitCode).toBe(0);
    expect([result.command, ...result.args]).toEqual(["sleep", "0"]);
  });
});

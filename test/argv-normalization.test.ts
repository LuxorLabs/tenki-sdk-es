/**
 * Argv reaching the guest must be the argv the caller meant (CLO-4671).
 *
 * `Session.exec` splits argv across `command` and `options.args`, so the
 * natural `exec(["sh", "-c", cmd])` puts the whole array into `cmd[0]`.
 * TypeScript rejects that call, but plain-JS callers are unprotected and
 * protobuf-es accepts the nested array without complaint, so the guest execs a
 * binary literally named `sh,-c,echo hi` and the caller sees an empty result.
 *
 * These tests assert on the start frame's `cmd`, so they pin the wire contract
 * without needing a sandbox.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import {
  RunResponseSchema,
  SandboxSessionSchema,
  SessionState,
  type RunRequest,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { run } from "../src/process.js";
import { Session } from "../src/session.js";

/** Session whose guest records the start frame it was sent, then exits cleanly. */
function capturingSession(): { session: Session; cmd: () => string[] } {
  const captured: string[][] = [];
  const dataPlaneClient = {
    run: vi.fn((requests: AsyncIterable<{ frame?: RunRequest }>) =>
      (async function* () {
        const it = requests[Symbol.asyncIterator]();
        const first = await it.next();
        const payload = first.value?.frame?.payload;
        if (payload?.case === "start") captured.push([...payload.value.cmd]);
        yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 1n } } }) };
        yield {
          frame: create(RunResponseSchema, {
            payload: { case: "exit", value: { exitCode: 0, reason: "exit" } },
          }),
        };
      })(),
    ),
  };
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  // 5th arg is sshOptions; the data-plane ready budget is 6th.
  const session = new Session({} as never, proto, "tk_test", "wss://gateway.tenki.test", undefined, 5);
  (session as any).dataPlaneClient = dataPlaneClient;
  return { session, cmd: () => captured[0] ?? [] };
}

/** The `cmd` a `Session.exec(...)` call would put on the wire. */
async function wireCmd(command: unknown, options?: unknown): Promise<string[]> {
  const { session, cmd } = capturingSession();
  await session.exec(command as string, options as undefined);
  return cmd();
}

describe("Session.exec argv", () => {
  it("passes a single array through as argv", async () => {
    await expect(wireCmd(["sh", "-c", "echo hi"])).resolves.toEqual(["sh", "-c", "echo hi"]);
  });

  it("leaves the command + args form unchanged", async () => {
    await expect(wireCmd("sh", { args: ["-c", "echo hi"] })).resolves.toEqual(["sh", "-c", "echo hi"]);
  });

  it("rejects mixing the array form with options.args", async () => {
    await expect(wireCmd(["sh", "-c"], { args: ["echo hi"] })).rejects.toThrow(TypeError);
  });
});

describe("run() argv validation", () => {
  it("rejects a nested array before dialling the guest", () => {
    // Throws on the argv itself, so no session is needed.
    expect(() => run({} as never, ["sh", "-c", ["echo", "hi"] as never])).toThrow(TypeError);
  });

  it("rejects a plain object, which could only stringify to [object Object]", () => {
    expect(() => run({} as never, ["sh", { c: 1 } as never])).toThrow(TypeError);
  });

  it("still rejects an empty argv", () => {
    expect(() => run({} as never, [])).toThrow(/empty command/);
  });
});

describe("argv scalar compatibility", () => {
  // protobuf-es silently accepted these onto the wire, so untyped JS callers may
  // already be passing them; they must keep working, and now stringify correctly.
  it.each([
    ["number", 5, "5"],
    ["boolean", true, "true"],
    ["object with a real toString", new URL("https://tenki.test/x"), "https://tenki.test/x"],
  ])("coerces a %s argv part instead of rejecting it", async (_label, part, expected) => {
    await expect(wireCmd("ls", { args: [part] })).resolves.toEqual(["ls", expected]);
  });
});

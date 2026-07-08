import { describe, expect, it } from "vitest";

import { isSuccess, stderrText, stdoutText } from "../src/result.js";
import type { ExecResult } from "../src/result.js";

function makeResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    executionId: "exec-1",
    sessionId: "sess-1",
    command: "echo",
    args: ["hello"],
    status: "SUCCEEDED",
    exitCode: 0,
    durationMs: 100,
    outputs: [],
    stdout: new TextEncoder().encode("hello world\n"),
    stderr: new Uint8Array(),
    ...overrides,
  };
}

describe("stdoutText", () => {
  it("decodes and trims stdout", () => {
    expect(stdoutText(makeResult())).toBe("hello world");
  });

  it("returns empty string for empty stdout", () => {
    expect(stdoutText(makeResult({ stdout: new Uint8Array() }))).toBe("");
  });
});

describe("stderrText", () => {
  it("decodes and trims stderr", () => {
    const r = makeResult({ stderr: new TextEncoder().encode("error msg\n") });
    expect(stderrText(r)).toBe("error msg");
  });
});

describe("isSuccess", () => {
  it("returns true for SUCCEEDED", () => {
    expect(isSuccess("SUCCEEDED")).toBe(true);
  });

  it("returns false for FAILED", () => {
    expect(isSuccess("FAILED")).toBe(false);
  });

  it("returns false for TIMED_OUT", () => {
    expect(isSuccess("TIMED_OUT")).toBe(false);
  });
});

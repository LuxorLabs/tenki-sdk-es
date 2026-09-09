import type { DiskUsage } from "./disk.js";

export type CommandStatus = "UNSPECIFIED" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT";

export interface ExecResult {
  sessionId: string;
  command: string;
  args: string[];
  status: CommandStatus;
  exitCode: number;
  durationMs: number;
  startedAt?: Date;
  endedAt?: Date;
  outputs: import("./options.js").Output[];
  stdout: Uint8Array;
  stderr: Uint8Array;
  /** Guest terminal reason: "exit", "signaled", "timeout" or "grace_timeout". */
  reason?: string;
  /** Sandbox filesystem state observed while the command ran. */
  disk?: DiskUsage;
}

export function stdoutText(result: ExecResult): string {
  return new TextDecoder().decode(result.stdout).trim();
}

export function stderrText(result: ExecResult): string {
  return new TextDecoder().decode(result.stderr).trim();
}

export function isSuccess(status: CommandStatus): boolean {
  return status === "SUCCEEDED";
}

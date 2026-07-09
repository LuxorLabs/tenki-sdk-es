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

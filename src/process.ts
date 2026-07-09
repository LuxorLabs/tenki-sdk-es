import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

import {
  CapabilityUnavailableError,
  dataPlaneNotReadyError,
  isDataPlaneEdgeNotReady,
  PrimitiveTimeoutError,
} from "./errors.js";
import {
  RunRequestSchema,
  RunSignal_Sig,
  SandboxSessionDataPlaneServiceRunRequestSchema,
  type RunRequest,
  type RunResponse,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { sleepReadyBackoff } from "./ready-backoff.js";
import { isRefusedStreamOrGoAway } from "./refused-stream.js";
import type { Session } from "./session.js";

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array>;
  privileged?: boolean;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  signal?: string;
  durationMs?: number;
  /** Reason string from the guest-agent. "exit" on natural exit, "signaled" on signal, etc. */
  reason?: string;
  /** Raw errno on fork/exec/wait failures (ENOENT, EMFILE, EACCES, ...). */
  errno?: number;
}

export interface ProcessRunHandle extends PromiseLike<ProcessRunResult> {
  readonly pid: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;
  signal(signal: string): Promise<void>;
  kill(): Promise<void>;
}

function isRetryableRunStreamEstablishmentError(err: unknown): boolean {
  if (isDataPlaneEdgeNotReady(err) || isRefusedStreamOrGoAway(err)) return true;
  const connectErr = err instanceof ConnectError ? err : ConnectError.from(err);
  if (connectErr.code !== Code.Aborted && connectErr.code !== Code.Unavailable) return false;
  return /ECONNRESET|connection reset|socket hang up|unexpected EOF|stream closed before headers/i.test(
    connectErr.message,
  );
}

export function run(_session: Session, _argv: string[], _options?: ProcessRunOptions): ProcessRunHandle {
  const session = _session;
  const argv = _argv;
  const options = _options;
  if (argv.length === 0 || !argv[0]) throw new Error("empty command");

  const startRequest = create(RunRequestSchema, {
    payload: {
      case: "start",
      value: {
        sessionId: session.id,
        cmd: [...argv],
        cwd: options?.cwd ?? "",
        env: options?.env ?? {},
        streamStdin: true,
        privileged: options?.privileged ?? false,
      },
    },
  });
  let outbound = new AsyncQueue<RunRequest>();
  outbound.push(startRequest);
  let stdinClosed = false;
  let replayable = true;
  const stdinCloseRequest = () => create(RunRequestSchema, { payload: { case: "stdinClose", value: true } });
  const resetOutbound = () => {
    outbound = new AsyncQueue<RunRequest>();
    outbound.push(startRequest);
    if (stdinClosed) {
      outbound.push(stdinCloseRequest());
    }
  };
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    outbound.push(stdinCloseRequest());
  };
  const responses = (async function* () {
    const deadline = Date.now() + session.dataPlaneReadyBudgetMs();
    let reauthAttempted = false;
    for (let attempt = 0; ; attempt++) {
      const activeOutbound = outbound;
      const dataPlane = await session.requireDataPlane();
      const activeResponses = unwrapDataPlaneRun(dataPlane.run(wrapDataPlaneRun(activeOutbound)));
      let receivedResponse = false;
      try {
        for await (const frame of activeResponses) {
          receivedResponse = true;
          yield frame;
        }
        return;
      } catch (err) {
        if (!reauthAttempted && (await session.reauthOnUnauthenticated(err))) {
          reauthAttempted = true;
          activeOutbound.close();
          resetOutbound();
          continue;
        }
        if (!receivedResponse && replayable && isRetryableRunStreamEstablishmentError(err)) {
          activeOutbound.close();
          if (Date.now() >= deadline) {
            if (isDataPlaneEdgeNotReady(err)) throw dataPlaneNotReadyError(err);
            throw err;
          }
          await sleepReadyBackoff(attempt, deadline);
          resetOutbound();
          continue;
        }
        throw err;
      }
    }
  })();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let resolvePid: (pid: number) => void = () => {};
  let rejectPid: (err: unknown) => void = () => {};
  const pid = new Promise<number>((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  // Suppress unhandled-rejection noise when callers (e.g. Session.exec on a
  // CapabilityUnavailable fallback path) consume `result` but never await
  // `pid`. Subsequent `await proc.pid` callers still observe the rejection.
  pid.catch(() => {});

  const result = (async (): Promise<ProcessRunResult> => {
    try {
      for await (const frame of responses) {
        switch (frame.payload.case) {
          case "started":
            resolvePid(Number(frame.payload.value.pid));
            break;
          case "stdout":
            stdoutChunks.push(frame.payload.value);
            stdoutController?.enqueue(frame.payload.value);
            break;
          case "stderr":
            stderrChunks.push(frame.payload.value);
            stderrController?.enqueue(frame.payload.value);
            break;
          case "exit": {
            const exit = frame.payload.value;
            if (exit.reason.startsWith("first_frame_timeout")) {
              throw new PrimitiveTimeoutError("run", exit.reason);
            }
            if (exit.reason.startsWith("capability_unavailable")) {
              throw new CapabilityUnavailableError("run", exit.reason);
            }
            stdoutController?.close();
            stderrController?.close();
            return {
              exitCode: exit.exitCode,
              signal: exit.signal || undefined,
              durationMs: Number(exit.durationMs),
              stdout: concatUint8Arrays(stdoutChunks),
              stderr: concatUint8Arrays(stderrChunks),
              reason: exit.reason,
              errno: exit.errno,
            };
          }
        }
      }
      throw new Error("sandbox run stream closed before exit");
    } catch (err) {
      if (isDataPlaneEdgeNotReady(err)) {
        err = dataPlaneNotReadyError(err);
      }
      if (err instanceof ConnectError && err.code === Code.Unimplemented) {
        err = new CapabilityUnavailableError("run", err.message);
      }
      rejectPid(err);
      stdoutController?.error(err);
      stderrController?.error(err);
      throw err;
    } finally {
      outbound.close();
    }
  })();
  // Suppress unhandled-rejection noise when callers (e.g. Session.stream on a
  // CapabilityUnavailable fallback path) consume `proc.pid` and skip awaiting
  // the result thenable. Subsequent `await proc` callers still observe the
  // rejection via `then` below.
  result.catch(() => {});

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      replayable = false;
      outbound.push(create(RunRequestSchema, { payload: { case: "stdin", value: chunk } }));
    },
    close() {
      closeStdin();
    },
    abort(reason) {
      replayable = false;
      outbound.fail(reason);
    },
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrController = controller;
    },
  });

  if (options?.stdin) {
    void options.stdin.pipeTo(stdin).catch((err) => outbound.fail(err));
  }

  return {
    stdout,
    stderr,
    stdin,
    get pid() {
      return pid;
    },
    signal(signal: string) {
      replayable = false;
      outbound.push(
        create(RunRequestSchema, {
          payload: { case: "signal", value: { signal: signalNameToProto(signal) } },
        }),
      );
      return Promise.resolve();
    },
    kill() {
      return this.signal("KILL");
    },
    then(onfulfilled, onrejected) {
      return result.then(onfulfilled, onrejected);
    },
  } as ProcessRunHandle & { readonly pid: Promise<number> };
}

async function* wrapDataPlaneRun(outbound: AsyncIterable<RunRequest>) {
  for await (const frame of outbound) {
    yield create(SandboxSessionDataPlaneServiceRunRequestSchema, { frame });
  }
}

async function* unwrapDataPlaneRun(responses: AsyncIterable<{ frame?: RunResponse }>) {
  for await (const response of responses) {
    if (response.frame) {
      yield response.frame;
    }
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;
  private error: unknown;

  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.done = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    this.error = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (next.done) {
        // close() resolves pending consumers with {done:true} even when fail()
        // captured an error first; re-check so a stdin producer failure
        // surfaces instead of looking like a clean EOF.
        if (this.error) throw this.error;
        return;
      }
      yield next.value;
    }
  }
}

function signalNameToProto(signal: string): RunSignal_Sig {
  switch (signal.replace(/^SIG/, "").toUpperCase()) {
    case "KILL":
      return RunSignal_Sig.KILL;
    case "INT":
      return RunSignal_Sig.INT;
    case "HUP":
      return RunSignal_Sig.HUP;
    case "USR1":
      return RunSignal_Sig.USR1;
    case "USR2":
      return RunSignal_Sig.USR2;
    default:
      return RunSignal_Sig.TERM;
  }
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

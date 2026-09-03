import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

import {
  CapabilityUnavailableError,
  dataPlaneNotReadyError,
  isDataPlaneEdgeNotReady,
  isSessionTerminatedReason,
  mapError,
  PrimitiveTimeoutError,
  SandboxError,
  SessionTerminatedError,
  sessionTerminationCause,
} from "./errors.js";
import {
  RunRequestSchema,
  RunSignal_Sig,
  SandboxSessionDataPlaneServiceRunRequestSchema,
  type RunRequest,
  type RunResponse,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { sleepReadyBackoff } from "./ready-backoff.js";
import { isRetryableStreamTransportError } from "./refused-stream.js";
import type { Session } from "./session.js";

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: ReadableStream<Uint8Array>;
  privileged?: boolean;
  /**
   * Wall-clock budget for the run; omitted or `0` means unbounded. Enforced by
   * the guest-agent, which resolves a spent budget with `timedOut: true` rather
   * than rejecting.
   */
  timeoutMs?: number;
  /** Signals the guest process and rejects the run with the signal's reason. */
  signal?: AbortSignal;
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
  /** Execution budget spent. May be set alongside `exitCode: 0`. */
  timedOut?: boolean;
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
  return isDataPlaneEdgeNotReady(err) || isRetryableStreamTransportError(err);
}

function argvPartTypeName(part: unknown): string {
  if (Array.isArray(part)) return "array";
  return part === null ? "null" : typeof part;
}

/**
 * Whether String(part) would yield a binary name no guest can resolve. Arrays
 * and default-toString objects would; a number, or an object with a real
 * toString (URL, Date), stringifies to something the caller plausibly meant, so
 * it keeps the historical coercion.
 */
function isUnstringifiableArgvPart(part: unknown): boolean {
  if (Array.isArray(part)) return true;
  if (part === null || typeof part !== "object") return false;
  return String(part).startsWith("[object ");
}

/**
 * Resolve the two argv forms into one. A lone array is the argv itself, so
 * `exec(["sh", "-c", cmd])` means the same as `exec("sh", { args: ["-c", cmd] })`.
 */
export function normalizeArgv(command: string | string[], args?: string[]): string[] {
  if (!Array.isArray(command)) return [command, ...(args ?? [])];
  if (args?.length) {
    throw new TypeError("pass argv as a single array or as command plus options.args, not both");
  }
  return [...command];
}

export function run(_session: Session, _argv: string[], _options?: ProcessRunOptions): ProcessRunHandle {
  const session = _session;
  const argv = _argv;
  const options = _options;
  if (argv.length === 0 || !argv[0]) throw new Error("empty command");
  const bad = argv.findIndex(isUnstringifiableArgvPart);
  if (bad !== -1) {
    throw new TypeError(`argv[${bad}] must be a string, got ${argvPartTypeName(argv[bad])}`);
  }
  // protobuf-es puts a non-string straight onto the wire, so coerce here.
  const cmd = argv.map((part) => String(part));

  // Round up: flooring a sub-millisecond budget to 0 would mean unbounded.
  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? Math.max(1, Math.floor(options.timeoutMs)) : 0;
  const startRequest = create(RunRequestSchema, {
    payload: {
      case: "start",
      value: {
        sessionId: session.id,
        cmd,
        cwd: options?.cwd ?? "",
        env: options?.env ?? {},
        streamStdin: true,
        privileged: options?.privileged ?? false,
        timeoutMs: Math.min(timeoutMs, 0xffff_ffff),
      },
    },
  });
  let outbound = new AsyncQueue<RunRequest>();
  outbound.push(startRequest);
  let stdinClosed = false;
  let replayable = true;
  let receivedStarted = false;
  // Replayed onto a reconnected stream so a pre-start abort is not lost.
  const signalRequests: RunRequest[] = [];
  const stdinCloseRequest = () => create(RunRequestSchema, { payload: { case: "stdinClose", value: true } });
  const resetOutbound = () => {
    outbound = new AsyncQueue<RunRequest>();
    outbound.push(startRequest);
    if (stdinClosed) {
      outbound.push(stdinCloseRequest());
    }
    for (const signalRequest of signalRequests) {
      outbound.push(signalRequest);
    }
  };
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    outbound.push(stdinCloseRequest());
  };
  let abandonedOnce = false;
  // Closing the outbound queue only half-closes the request side.
  const rpcAbort = new AbortController();
  const responses = (async function* () {
    const deadline = Date.now() + session.dataPlaneReadyBudgetMs();
    let reauthAttempted = false;
    for (let attempt = 0; ; attempt++) {
      const activeOutbound = outbound;
      const dataPlane = await session.requireDataPlane();
      if (abandonedOnce) return;
      const activeResponses = unwrapDataPlaneRun(
        dataPlane.run(wrapDataPlaneRun(activeOutbound), { signal: rpcAbort.signal }),
      );
      let receivedResponse = false;
      try {
        for await (const frame of activeResponses) {
          receivedResponse = true;
          yield frame;
        }
        return;
      } catch (err) {
        if (abandonedOnce) return;
        if (!reauthAttempted && (await session.reauthOnUnauthenticated(err))) {
          reauthAttempted = true;
          activeOutbound.close();
          if (abandonedOnce) return;
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
          // resetOutbound re-queues the start request, so an abandoned run
          // would execute the command a second time.
          if (abandonedOnce) return;
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
            receivedStarted = true;
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
            if (isSessionTerminatedReason(exit.reason)) {
              throw new SessionTerminatedError(exit.reason, {
                terminationCause: sessionTerminationCause(exit.reason),
              });
            }
            stdoutController?.close();
            stderrController?.close();
            stdoutController = undefined;
            stderrController = undefined;
            return {
              exitCode: exit.exitCode,
              signal: exit.signal || undefined,
              durationMs: Number(exit.durationMs),
              stdout: concatUint8Arrays(stdoutChunks),
              stderr: concatUint8Arrays(stderrChunks),
              reason: exit.reason,
              errno: exit.errno,
              timedOut: exit.timedOut,
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
      } else if (err instanceof ConnectError) {
        err = mapError(err);
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

  const sendSignal = (signal: string) => {
    const request = create(RunRequestSchema, {
      payload: { case: "signal", value: { signal: signalNameToProto(signal) } },
    });
    signalRequests.push(request);
    if (receivedStarted) replayable = false;
    outbound.push(request);
  };

  // An abort settles the run without an exit frame or stream error.
  let rejectAbandoned: (err: unknown) => void = () => {};
  const abandoned = new Promise<never>((_, reject) => {
    rejectAbandoned = reject;
  });
  abandoned.catch(() => {});
  const settled = Promise.race([result, abandoned]);
  settled.catch(() => {});

  const abandon = (err: unknown) => {
    if (abandonedOnce) return;
    abandonedOnce = true;
    // Hands off to the guest's SIGTERM -> SIGKILL escalation; deliberately does
    // not wait for an exit frame, which may never arrive.
    sendSignal("TERM");
    rejectPid(err);
    stdoutController?.error(err);
    stderrController?.error(err);
    rejectAbandoned(err);
    outbound.close();
    rpcAbort.abort(err);
  };

  const abortSignal = options?.signal;
  const onAbort = () => abandon(abortReason(abortSignal));
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  void result
    .finally(() => {
      abandonedOnce = true;
      abortSignal?.removeEventListener("abort", onAbort);
    })
    .catch(() => {});

  return {
    stdout,
    stderr,
    stdin,
    get pid() {
      return pid;
    },
    signal(signal: string) {
      sendSignal(signal);
      return Promise.resolve();
    },
    kill() {
      return this.signal("KILL");
    },
    then(onfulfilled, onrejected) {
      return settled.then(onfulfilled, onrejected);
    },
  } as ProcessRunHandle & { readonly pid: Promise<number> };
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason;
  if (reason !== undefined && reason !== null) return reason;
  return new SandboxError("sandbox run aborted");
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

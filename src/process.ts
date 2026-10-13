import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

import type { DiskUsage } from "./disk.js";
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
  // Stream output without result capture; both readable streams must be drained.
  streamOnly?: boolean;
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
  /** Sandbox filesystem state observed while the command ran. */
  disk?: DiskUsage;
}

/** Maps the guest exit frame's disk fields, which are absent on older guests. */
function diskUsageFromExit(exit: {
  diskTotalBytes: bigint;
  diskFreeBytes: bigint;
  diskAvailableBytes: bigint;
  diskMinAvailableBytes: bigint;
}): DiskUsage | undefined {
  if (exit.diskTotalBytes <= 0n) return undefined;
  return {
    totalBytes: Number(exit.diskTotalBytes),
    freeBytes: Number(exit.diskFreeBytes),
    availableBytes: Number(exit.diskAvailableBytes),
    minAvailableBytes: Number(exit.diskMinAvailableBytes),
  };
}

export interface ProcessRunHandle extends PromiseLike<ProcessRunResult> {
  readonly pid: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdin: WritableStream<Uint8Array>;
  signal(signal: string): Promise<void>;
  kill(): Promise<void>;
}

function traceRunTiming(sessionId: string, startedAt: number, stage: string, details?: Record<string, unknown>): void {
  if (typeof process === "undefined" || process.env?.TENKI_SDK_RUN_TRACE_TIMING !== "1") return;
  console.error(
    `TENKI_SDK_RUN_TIMING ${JSON.stringify({
      sessionId,
      stage,
      epochMs: Date.now(),
      elapsedMs: performance.now() - startedAt,
      ...details,
    })}`,
  );
}

function isProvisioningSessionNotFound(err: unknown, provisioningPending: boolean): boolean {
  const connectErr = err instanceof ConnectError ? err : ConnectError.from(err);
  return provisioningPending && connectErr.code === Code.NotFound && /\bsession not found\b/i.test(connectErr.message);
}

function isRetryableRunStreamEstablishmentError(err: unknown, provisioningPending: boolean): boolean {
  const connectErr = err instanceof ConnectError ? err : ConnectError.from(err);
  return (
    isDataPlaneEdgeNotReady(err) ||
    isRetryableStreamTransportError(err) ||
    isProvisioningSessionNotFound(err, provisioningPending) ||
    (provisioningPending && connectErr.code === Code.Unavailable)
  );
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

  const runStartedAt = performance.now();
  traceRunTiming(session.id, runStartedAt, "called");

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
      traceRunTiming(session.id, runStartedAt, "attempt_begin", { attempt });
      const dataPlane = await session.requireDataPlane(false);
      traceRunTiming(session.id, runStartedAt, "data_plane_ready", { attempt });
      if (abandonedOnce) return;
      const activeResponses = unwrapDataPlaneRun(
        dataPlane.run(wrapDataPlaneRun(activeOutbound), { signal: rpcAbort.signal }),
      );
      traceRunTiming(session.id, runStartedAt, "stream_opened", { attempt });
      let receivedResponse = false;
      try {
        for await (const frame of activeResponses) {
          // Keepalives are not a response: keep the establishment retry open.
          if (frame.payload.case !== "keepalive") {
            if (!receivedResponse) traceRunTiming(session.id, runStartedAt, "first_response", { attempt });
            receivedResponse = true;
            session.markDataPlaneServing(dataPlane);
          }
          yield frame;
        }
        return;
      } catch (err) {
        traceRunTiming(session.id, runStartedAt, "attempt_error", {
          attempt,
          code: ConnectError.from(err).code,
          receivedResponse,
        });
        if (abandonedOnce) return;
        if (!reauthAttempted && (await session.reauthOnUnauthenticated(err))) {
          reauthAttempted = true;
          activeOutbound.close();
          if (abandonedOnce) return;
          resetOutbound();
          continue;
        }
        const provisioningPending = session.dataPlaneProvisioningPending(dataPlane);
        if (!receivedResponse && replayable && isRetryableRunStreamEstablishmentError(err, provisioningPending)) {
          activeOutbound.close();
          if (Date.now() >= deadline) {
            if (isDataPlaneEdgeNotReady(err)) throw dataPlaneNotReadyError(err);
            throw err;
          }
          if (isProvisioningSessionNotFound(err, provisioningPending)) {
            await session.refreshHintedDataPlane(dataPlane);
          }
          if (attempt > 0) await sleepReadyBackoff(attempt - 1, deadline);
          traceRunTiming(session.id, runStartedAt, "retry_backoff_complete", { attempt });
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
  const stdout = new RunOutput(options?.streamOnly ?? false);
  const stderr = new RunOutput(options?.streamOnly ?? false);
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
          case "keepalive":
            // Keepalives only keep a quiet stream active; they carry no output.
            break;
          case "started":
            receivedStarted = true;
            resolvePid(Number(frame.payload.value.pid));
            break;
          case "stdout":
            await stdout.push(frame.payload.value);
            break;
          case "stderr":
            await stderr.push(frame.payload.value);
            break;
          case "exit": {
            const exit = frame.payload.value;
            traceRunTiming(session.id, runStartedAt, "exit_response");
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
            stdout.close();
            stderr.close();
            return {
              exitCode: exit.exitCode,
              signal: exit.signal || undefined,
              durationMs: Number(exit.durationMs),
              stdout: stdout.read(),
              stderr: stderr.read(),
              reason: exit.reason,
              errno: exit.errno,
              timedOut: exit.timedOut,
              disk: diskUsageFromExit(exit),
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
      stdout.fail(err);
      stderr.fail(err);
      throw err;
    } finally {
      outbound.close();
      rpcAbort.abort();
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
    stdout.fail(err);
    stderr.fail(err);
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
    stdout: stdout.stream,
    stderr: stderr.stream,
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

// Streaming-only queues apply backpressure instead of retaining unlimited unread output.
class RunOutput {
  readonly stream: ReadableStream<Uint8Array>;
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private capacityAvailable?: () => void;
  private chunks: Uint8Array[] = [];

  constructor(private readonly streamOnly: boolean) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => {
          this.releaseCapacity();
        },
        cancel: () => {
          this.controller = undefined;
          this.releaseCapacity();
        },
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
    );
  }

  async push(data: Uint8Array): Promise<void> {
    if (!this.streamOnly) this.chunks.push(data);
    this.controller?.enqueue(data);
    if (this.streamOnly && this.controller && (this.controller.desiredSize ?? 0) <= 0) {
      await new Promise<void>((resolve) => {
        this.capacityAvailable = resolve;
      });
    }
  }

  close(): void {
    this.controller?.close();
    this.controller = undefined;
    this.releaseCapacity();
  }

  fail(err: unknown): void {
    this.controller?.error(err);
    this.controller = undefined;
    this.releaseCapacity();
  }

  read(): Uint8Array {
    return concatUint8Arrays(this.chunks);
  }

  private releaseCapacity(): void {
    this.capacityAvailable?.();
    this.capacityAvailable = undefined;
  }
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

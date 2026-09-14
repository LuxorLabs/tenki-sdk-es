import type { Session } from "./session.js";
import {
  exposeHostPort,
  type HostPortTunnel,
  type HostPortTunnelEndpoint,
  type HostPortTunnelOptions,
  type HostPortTunnelTermination,
  type TunnelTerminationReason,
} from "./tunnel.js";

export type ResilientHostPortTunnelState = "open" | "reconnecting" | "closed";

export type ResilientHostPortTunnelStateEvent =
  | { state: "connecting" }
  | { state: "open"; tunnel: HostPortTunnel }
  | { state: "reconnecting"; reason: HostPortTunnelTermination; attempt: number; delayMs: number }
  | { state: "port-changed"; previousPort: number; sandboxPort: number }
  | { state: "closed"; reason: HostPortTunnelTermination };

export interface ResilientHostPortTunnelOptions extends HostPortTunnelOptions {
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface ResilientHostPortTunnel extends HostPortTunnel {
  readonly state: ResilientHostPortTunnelState;
  endpoint(): HostPortTunnelEndpoint;
  onStateChange(cb: (event: ResilientHostPortTunnelStateEvent) => void): void;
}

const RETRY_REASONS = new Set<TunnelTerminationReason>([
  "transport_error",
  "engine_terminated",
  "engine_draining",
  "timeout",
]);

export async function exposeHostPortResilient(
  session: Session,
  hostAddr: string,
  options?: ResilientHostPortTunnelOptions,
): Promise<ResilientHostPortTunnel> {
  const initialBackoffMs = options?.initialBackoffMs ?? 250;
  const maxBackoffMs = options?.maxBackoffMs ?? 10_000;
  const stateListeners = new Set<(event: ResilientHostPortTunnelStateEvent) => void>();
  const terminationListeners = new Set<(termination: HostPortTunnelTermination) => void>();

  let state: ResilientHostPortTunnelState = "open";
  let current = await exposeHostPort(session, hostAddr, options);
  let closed = false;
  let finalTerminationResolved = false;
  let resolveFinalTermination!: (termination: HostPortTunnelTermination) => void;
  let wakeReconnectSleep: (() => void) | undefined;
  const finalTermination = new Promise<HostPortTunnelTermination>((resolve) => {
    resolveFinalTermination = resolve;
  });

  const emitState = (event: ResilientHostPortTunnelStateEvent) => {
    for (const listener of stateListeners) listener(event);
  };
  const finish = (termination: HostPortTunnelTermination) => {
    if (finalTerminationResolved) return;
    finalTerminationResolved = true;
    state = "closed";
    for (const listener of terminationListeners) listener(termination);
    emitState({ state: "closed", reason: termination });
    resolveFinalTermination(termination);
  };
  const setCurrent = (next: HostPortTunnel) => {
    const previousPort = current.sandboxPort;
    current = next;
    state = "open";
    emitState({ state: "open", tunnel: next });
    if (previousPort !== next.sandboxPort) {
      emitState({ state: "port-changed", previousPort, sandboxPort: next.sandboxPort });
    }
  };

  const reconnectLoop = async () => {
    let attempt = 0;
    for (;;) {
      let termination = await current.terminated;
      if (closed) return;
      if (!RETRY_REASONS.has(termination.reason)) {
        finish(termination);
        return;
      }

      for (;;) {
        attempt++;
        state = "reconnecting";
        if (termination.reason === "engine_draining") {
          // Rolling deploys have already sent HTTP/2 GOAWAY, so reconnect immediately to a healthy engine.
          attempt = 0;
        }
        const delayMs =
          termination.reason === "engine_draining" ? 0 : jitteredBackoff(initialBackoffMs, maxBackoffMs, attempt);
        emitState({ state: "reconnecting", reason: termination, attempt, delayMs });
        await sleep(
          delayMs,
          () => closed,
          (wake) => {
            wakeReconnectSleep = wake;
          },
        );
        wakeReconnectSleep = undefined;
        if (closed) return;

        try {
          const next = await exposeHostPort(session, hostAddr, options);
          attempt = 0;
          setCurrent(next);
          break;
        } catch (error) {
          if (closed) return;
          termination = { reason: "transport_error", error };
          emitState({
            state: "reconnecting",
            reason: termination,
            attempt,
            delayMs: 0,
          });
        }
      }
    }
  };
  reconnectLoop().catch((error: unknown) => finish({ reason: "transport_error", error }));

  return {
    endpoint() {
      return [current.sandboxAddress, current.sandboxPort];
    },
    get sandboxPort() {
      return current.sandboxPort;
    },
    get sandboxAddress() {
      return current.sandboxAddress;
    },
    get state() {
      return state;
    },
    async close() {
      closed = true;
      wakeReconnectSleep?.();
      await current.close();
      finish({ reason: "sdk_closed" });
    },
    terminated: finalTermination,
    onTerminated(cb) {
      if (finalTerminationResolved) finalTermination.then(cb).catch(() => {});
      else terminationListeners.add(cb);
    },
    onStateChange(cb) {
      stateListeners.add(cb);
    },
  };
}

export async function resilientHostPortTunnel(
  session: Session,
  host: string,
  port: number,
  options?: ResilientHostPortTunnelOptions,
): Promise<ResilientHostPortTunnel> {
  return exposeHostPortResilient(session, `${host}:${port}`, options);
}

function jitteredBackoff(initialBackoffMs: number, maxBackoffMs: number, attempt: number): number {
  const base = Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(base * jitter);
}

async function sleep(ms: number, shouldStop: () => boolean, setWake: (wake: () => void) => void): Promise<void> {
  if (shouldStop()) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    setWake(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

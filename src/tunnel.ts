import net from "node:net";
import { create } from "@bufbuild/protobuf";

import { CapabilityUnavailableError, mapError, PrimitiveTimeoutError } from "./errors.js";
import {
  HostPortTunnelRequestSchema,
  HostPortTunnelTerminated_Reason,
  SandboxSessionDataPlaneServiceHostPortTunnelRequestSchema,
  type HostPortTunnelRequest,
  type HostPortTunnelResponse,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type { Session } from "./session.js";

export interface HostPortTunnelOptions {
  sandboxBindAddress?: string;
  sandboxPort?: number;
  hostDialTargetLabel?: string;
}

export type TunnelTerminationReason =
  | "sdk_closed"
  | "host_closed"
  | "host_error"
  | "engine_terminated"
  | "engine_draining"
  | "transport_error"
  | "timeout";

export interface HostPortTunnelTermination {
  reason: TunnelTerminationReason;
  detail?: string;
  error?: unknown;
}

export type HostPortTunnelEndpoint = readonly [address: string, port: number];

export interface HostPortTunnel {
  sandboxPort: number;
  sandboxAddress: string;
  close(): Promise<void>;
  terminated: Promise<HostPortTunnelTermination>;
  onTerminated(cb: (termination: HostPortTunnelTermination) => void): void;
}

export async function exposeHostPort(
  session: Session,
  hostAddr: string,
  options?: HostPortTunnelOptions,
): Promise<HostPortTunnel> {
  for (let attempt = 0; ; attempt++) {
    const outbound = new AsyncQueue<HostPortTunnelRequest>();
    outbound.push(
      create(HostPortTunnelRequestSchema, {
        payload: {
          case: "open",
          value: {
            sessionId: session.id,
            sandboxBindAddress: options?.sandboxBindAddress ?? "",
            sandboxPort: options?.sandboxPort ?? 0,
            hostDialTargetLabel: options?.hostDialTargetLabel ?? hostAddr,
          },
        },
      }),
    );

    const dataPlane = await session.requireDataPlane();
    const responses = unwrapDataPlaneHostPortTunnel(dataPlane.hostPortTunnel(wrapDataPlaneHostPortTunnel(outbound)));
    const responseIterator = responses[Symbol.asyncIterator]();
    let first: IteratorResult<HostPortTunnelResponse>;
    try {
      first = await responseIterator.next();
    } catch (err) {
      if (attempt === 0 && (await session.reauthOnUnauthenticated(err))) {
        outbound.close();
        continue;
      }
      throw mapError(err);
    }
    if (first.done) throw new Error("sandbox host port tunnel closed before open");
    if (first.value.payload.case === "terminated") {
      const terminated = first.value.payload.value;
      if (terminated.reason === HostPortTunnelTerminated_Reason.CAPABILITY_UNAVAILABLE) {
        if (terminated.detail?.startsWith("first_frame_timeout")) {
          throw new PrimitiveTimeoutError("host_port_tunnel", terminated.detail);
        }
        throw new CapabilityUnavailableError("host_port_tunnel", terminated.detail || undefined);
      }
      throw new Error(
        terminated.detail || `sandbox host port tunnel failed: ${HostPortTunnelTerminated_Reason[terminated.reason]}`,
      );
    }
    if (first.value.payload.case !== "opened") throw new Error("sandbox host port tunnel did not open");

    const lastColon = hostAddr.lastIndexOf(":");
    if (lastColon < 0) throw new Error(`exposeHostPort hostAddr must be host:port, got ${hostAddr}`);
    const dialHost = hostAddr.slice(0, lastColon).replace(/^\[|\]$/g, "");
    const dialPort = parseInt(hostAddr.slice(lastColon + 1), 10);
    if (!dialPort) throw new Error(`exposeHostPort hostAddr port is invalid: ${hostAddr}`);

    const sockets = new Map<bigint, net.Socket>();
    let resolveTerminated!: (termination: HostPortTunnelTermination) => void;
    let terminatedResolved = false;
    const terminated = new Promise<HostPortTunnelTermination>((resolve) => {
      resolveTerminated = resolve;
    });
    const finish = (termination: HostPortTunnelTermination) => {
      if (terminatedResolved) return;
      terminatedResolved = true;
      resolveTerminated(termination);
    };
    const pump = async () => {
      try {
        for (;;) {
          const next = await responseIterator.next();
          if (next.done) {
            finish({ reason: "transport_error" });
            break;
          }
          const frame = next.value;
          switch (frame.payload.case) {
            case "accept": {
              const id = frame.payload.value.subStreamId;
              const socket = net.connect({ host: dialHost, port: dialPort });
              sockets.set(id, socket);
              socket.on("data", (data) => {
                const payload = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
                outbound.push(
                  create(HostPortTunnelRequestSchema, {
                    payload: { case: "data", value: { subStreamId: id, payload } },
                  }),
                );
              });
              socket.on("close", () => {
                sockets.delete(id);
                outbound.push(
                  create(HostPortTunnelRequestSchema, {
                    payload: { case: "close", value: { subStreamId: id, reason: "host_closed" } },
                  }),
                );
              });
              socket.on("error", () => {
                sockets.delete(id);
                outbound.push(
                  create(HostPortTunnelRequestSchema, {
                    payload: { case: "close", value: { subStreamId: id, reason: "host_error" } },
                  }),
                );
              });
              break;
            }
            case "data": {
              const { subStreamId, payload } = frame.payload.value;
              const socket = sockets.get(subStreamId);
              if (socket && !socket.destroyed) socket.write(payload);
              break;
            }
            case "halfClose":
              sockets.get(frame.payload.value.subStreamId)?.end();
              break;
            case "close":
              sockets.get(frame.payload.value.subStreamId)?.destroy();
              sockets.delete(frame.payload.value.subStreamId);
              break;
            case "ping":
              outbound.push(
                create(HostPortTunnelRequestSchema, {
                  payload: { case: "pong", value: { pingId: frame.payload.value.pingId } },
                }),
              );
              break;
            case "terminated":
              finish(mapTermination(frame.payload.value.reason, frame.payload.value.detail || undefined));
              return;
          }
        }
      } catch (error) {
        finish({ reason: "transport_error", error });
      } finally {
        for (const socket of sockets.values()) socket.destroy();
        sockets.clear();
        outbound.close();
      }
    };
    const supervised = pump();
    supervised.catch((error: unknown) => finish({ reason: "transport_error", error }));

    return {
      sandboxPort: first.value.payload.value.sandboxPort,
      sandboxAddress: first.value.payload.value.sandboxAddress,
      async close() {
        for (const socket of sockets.values()) socket.destroy();
        sockets.clear();
        // sub_stream_id 0 is a sentinel telling the engine + guest-agent to tear
        // down the whole tunnel (drop the listener, exit handleTunnel).
        outbound.push(
          create(HostPortTunnelRequestSchema, {
            payload: { case: "close", value: { subStreamId: 0n, reason: "sdk_closed" } },
          }),
        );
        outbound.close();
        finish({ reason: "sdk_closed" });
      },
      terminated,
      onTerminated(cb) {
        terminated.then(cb).catch(() => {});
      },
    };
  }
}

async function* wrapDataPlaneHostPortTunnel(outbound: AsyncIterable<HostPortTunnelRequest>) {
  for await (const frame of outbound) {
    yield create(SandboxSessionDataPlaneServiceHostPortTunnelRequestSchema, { frame });
  }
}

async function* unwrapDataPlaneHostPortTunnel(responses: AsyncIterable<{ frame?: HostPortTunnelResponse }>) {
  for await (const response of responses) {
    if (response.frame) yield response.frame;
  }
}

export async function hostPortTunnel(
  session: Session,
  host: string,
  port: number,
  options?: HostPortTunnelOptions,
): Promise<HostPortTunnel> {
  return exposeHostPort(session, `${host}:${port}`, options);
}

function mapTermination(reason: HostPortTunnelTerminated_Reason, detail?: string): HostPortTunnelTermination {
  switch (reason) {
    case HostPortTunnelTerminated_Reason.KEEPALIVE_TIMEOUT:
      return { reason: "timeout", detail };
    case HostPortTunnelTerminated_Reason.SESSION_LOST:
      return { reason: "engine_terminated", detail };
    case HostPortTunnelTerminated_Reason.ENGINE_DRAINING:
      return { reason: "engine_draining", detail };
    case HostPortTunnelTerminated_Reason.BIND_FAILED:
    case HostPortTunnelTerminated_Reason.PLATFORM_ERROR:
    case HostPortTunnelTerminated_Reason.CAPABILITY_UNAVAILABLE:
      return { reason: "host_error", detail };
    case HostPortTunnelTerminated_Reason.UNSPECIFIED:
    default:
      return { reason: "engine_terminated", detail };
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.done = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

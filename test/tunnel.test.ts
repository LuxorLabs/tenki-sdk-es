import net from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { DataPlaneNotReadyError } from "../src/errors.js";
import {
  HostPortTunnelResponseSchema,
  HostPortTunnelTerminated_Reason,
  type HostPortTunnelRequest,
  type HostPortTunnelResponse,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type { Session } from "../src/session.js";
import { exposeHostPortResilient } from "../src/tunnel-resilient.js";
import { exposeHostPort } from "../src/tunnel.js";

describe("host port tunnel liveness", () => {
  it("resolves terminated and fires onTerminated on terminated frame", async () => {
    const stream = new TestStream();
    stream.push(opened(9000));
    const session = makeSession(stream);

    const tunnel = await exposeHostPort(session, "127.0.0.1:1234");
    const onTerminated = vi.fn();
    tunnel.onTerminated(onTerminated);

    stream.push(terminated(HostPortTunnelTerminated_Reason.SESSION_LOST, "lost"));
    await expect(tunnel.terminated).resolves.toEqual({ reason: "engine_terminated", detail: "lost" });
    expect(onTerminated).toHaveBeenCalledWith({ reason: "engine_terminated", detail: "lost" });
  });

  it("maps engine draining terminated frame", async () => {
    const stream = new TestStream();
    stream.push(opened(9000));
    const tunnel = await exposeHostPort(makeSession(stream), "127.0.0.1:1234");

    stream.push(terminated(HostPortTunnelTerminated_Reason.ENGINE_DRAINING, "drain"));

    await expect(tunnel.terminated).resolves.toEqual({ reason: "engine_draining", detail: "drain" });
  });

  it("close resolves terminated with sdk_closed", async () => {
    const stream = new TestStream();
    stream.push(opened(9001));
    const tunnel = await exposeHostPort(makeSession(stream), "127.0.0.1:1234");

    await tunnel.close();

    await expect(tunnel.terminated).resolves.toEqual({ reason: "sdk_closed" });
  });

  it("resolves transport_error on abrupt stream error and tears down sockets", async () => {
    const serverSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      serverSockets.add(socket);
      socket.on("close", () => serverSockets.delete(socket));
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP server address");

    const stream = new TestStream();
    stream.push(opened(9002));
    const tunnel = await exposeHostPort(makeSession(stream), `127.0.0.1:${address.port}`);
    stream.push(
      create(HostPortTunnelResponseSchema, {
        payload: { case: "accept", value: { subStreamId: 1n } },
      }),
    );
    await waitFor(() => serverSockets.size === 1);

    const error = new Error("boom");
    stream.fail(error);

    const result = await tunnel.terminated;
    expect(result.reason).toBe("transport_error");
    expect(result.error).toBe(error);
    await waitFor(() => serverSockets.size === 0);
    server.close();
  });

  it("maps edge 404 stream-open failure to DataPlaneNotReadyError", async () => {
    const stream = new TestStream();
    stream.fail(new ConnectError("HTTP status 404 Not Found", Code.Unimplemented));

    await expect(exposeHostPort(makeSession(stream), "127.0.0.1:1234")).rejects.toBeInstanceOf(DataPlaneNotReadyError);
  });
});

describe("resilient host port tunnel", () => {
  it("reconnects on engine termination and emits port changes", async () => {
    const first = new TestStream();
    const second = new TestStream();
    first.push(opened(9100));
    second.push(opened(9101));
    const session = makeSession(first, second);

    const tunnel = await exposeHostPortResilient(session, "127.0.0.1:1234", {
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });
    const events: string[] = [];
    tunnel.onStateChange((event) => events.push(event.state));

    first.push(terminated(HostPortTunnelTerminated_Reason.SESSION_LOST, "lost"));
    await waitFor(() => tunnel.sandboxPort === 9101);

    expect(tunnel.endpoint()).toEqual([tunnel.sandboxAddress, 9101]);
    expect(tunnel.state).toBe("open");
    expect(events).toContain("reconnecting");
    expect(events).toContain("open");
    expect(events).toContain("port-changed");

    await tunnel.close();
  });

  it("retries immediately on engine draining", async () => {
    const first = new TestStream();
    const second = new TestStream();
    first.push(opened(9150));
    second.push(opened(9151));
    const session = makeSession(first, second);

    const tunnel = await exposeHostPortResilient(session, "127.0.0.1:1234", {
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
    });
    const reconnects: number[] = [];
    tunnel.onStateChange((event) => {
      if (event.state === "reconnecting") reconnects.push(event.delayMs);
    });

    first.push(terminated(HostPortTunnelTerminated_Reason.ENGINE_DRAINING, "drain"));
    await waitFor(() => tunnel.sandboxPort === 9151);

    expect(reconnects[0]).toBeLessThanOrEqual(1);
    await tunnel.close();
  });

  it("does not leak sockets across repeated reconnects", async () => {
    const streams = Array.from({ length: 101 }, (_, index) => {
      const stream = new TestStream();
      stream.push(opened(9200 + index));
      return stream;
    });
    const session = makeSession(...streams);
    const tunnel = await exposeHostPortResilient(session, "127.0.0.1:1234", {
      initialBackoffMs: 1,
      maxBackoffMs: 1,
    });

    for (let i = 0; i < 100; i++) {
      streams[i].push(terminated(HostPortTunnelTerminated_Reason.SESSION_LOST, `lost-${i}`));
      await waitFor(() => tunnel.sandboxPort === 9201 + i);
    }

    expect(tunnel.sandboxPort).toBe(9300);
    await tunnel.close();
  });
});

class TestStream implements AsyncIterable<HostPortTunnelResponse> {
  private values: HostPortTunnelResponse[] = [];
  private resolvers: Array<(result: IteratorResult<HostPortTunnelResponse>) => void> = [];
  private rejecters: Array<(error: unknown) => void> = [];
  private error: unknown;

  push(value: HostPortTunnelResponse): void {
    const resolve = this.resolvers.shift();
    this.rejecters.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: unknown): void {
    this.error = error;
    for (const reject of this.rejecters.splice(0)) reject(error);
    this.resolvers.splice(0);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<HostPortTunnelResponse> {
    for (;;) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      const next = await new Promise<IteratorResult<HostPortTunnelResponse>>((resolve, reject) => {
        this.resolvers.push(resolve);
        this.rejecters.push(reject);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

function makeSession(...streams: TestStream[]): Session {
  const hostPortTunnel = vi.fn(async function* (_requests: AsyncIterable<HostPortTunnelRequest>) {
    const stream = streams.shift();
    if (!stream) throw new Error("unexpected reconnect");
    for await (const frame of stream) yield { frame };
  });
  const dataPlane = { hostPortTunnel };
  return {
    id: "0195f137-9a14-7a0b-b829-4e6ff55e2fc5",
    rpcClient: { hostPortTunnel },
    requireDataPlane: vi.fn(async () => dataPlane),
    reauthOnUnauthenticated: vi.fn(async () => false),
  } as unknown as Session;
}

function opened(sandboxPort: number): HostPortTunnelResponse {
  return create(HostPortTunnelResponseSchema, {
    payload: {
      case: "opened",
      value: {
        sandboxPort,
        sandboxAddress: "127.0.0.1",
      },
    },
  });
}

function terminated(reason: HostPortTunnelTerminated_Reason, detail?: string): HostPortTunnelResponse {
  return create(HostPortTunnelResponseSchema, {
    payload: {
      case: "terminated",
      value: { reason, detail },
    },
  });
}

async function listen(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

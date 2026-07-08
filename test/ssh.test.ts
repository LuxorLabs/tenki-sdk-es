import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxSessionSchema, SessionState } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";
import { connectSSH } from "../src/ssh.js";

interface MockWebSocketInstance {
  url: string;
  options: Record<string, unknown>;
  emit(event: string, ...args: unknown[]): boolean;
}

const wsMock = vi.hoisted(() => ({
  instances: [] as MockWebSocketInstance[],
}));

vi.mock("ws", () => {
  class MockWebSocket {
    readonly url: string;
    readonly options: Record<string, unknown>;
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      this.options = options;
      wsMock.instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
      return true;
    }

    send(_data: unknown, cb?: (err?: Error) => void): void {
      cb?.();
    }

    close(): void {
      this.emit("close");
    }
  }

  return { default: MockWebSocket };
});

describe("SSH TLS options", () => {
  afterEach(() => {
    wsMock.instances.length = 0;
  });

  it("passes root certificates to the WebSocket TLS handshake", async () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";
    const pending = connectSSH("https://sandbox-gateway.tenki.test", "session-1", "tk_test", "tenki_session", {
      rootCertificates,
    });

    const ws = wsMock.instances[0];
    expect(ws.url).toBe("wss://sandbox-gateway.tenki.test/v1/ssh/session-1");
    expect(ws.options).toMatchObject({
      ca: rootCertificates,
      headers: { authorization: "Bearer tk_test" },
    });

    ws.emit("open");
    await expect(pending).resolves.toBeDefined();
  });

  it("threads session SSH options to connectSSH", async () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";
    const session = new Session(
      {} as never,
      create(SandboxSessionSchema, {
        id: "session-1",
        state: SessionState.RUNNING,
        ownerType: "SERVICE",
        ownerId: "self",
      }),
      "tk_test",
      "https://sandbox-gateway.tenki.test",
      "tenki_session",
      { rootCertificates },
    );

    const pending = session.ssh();
    const ws = wsMock.instances[0];
    expect(ws.options.ca).toBe(rootCertificates);

    ws.emit("open");
    await expect(pending).resolves.toBeDefined();
  });
});

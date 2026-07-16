import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxSessionSchema, SessionState } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";
import { issueSandboxSSHCert } from "../src/ssh-cert.js";
import { connectSSH, discoverSSHGatewayUrl } from "../src/ssh.js";

type GatewayClient = Parameters<typeof discoverSSHGatewayUrl>[0];

function fakeGatewayClient(
  gateways: Array<{ gatewayId?: string; healthy: boolean; wsBridgeEndpoint: string }>,
): GatewayClient {
  return {
    listActiveSSHGateways: async () => ({ gateways }),
  } as unknown as GatewayClient;
}

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

describe("SSH gateway discovery", () => {
  afterEach(() => {
    wsMock.instances.length = 0;
  });

  it("returns the per-session URL from the first healthy gateway with a bridge", async () => {
    const client = fakeGatewayClient([
      { healthy: false, wsBridgeEndpoint: "wss://gw-unhealthy.sb.tenki.test" },
      { healthy: true, wsBridgeEndpoint: "" },
      { healthy: true, wsBridgeEndpoint: "wss://gw-1.sb.tenki.test" },
      { healthy: true, wsBridgeEndpoint: "wss://gw-2.sb.tenki.test" },
    ]);
    await expect(discoverSSHGatewayUrl(client, "session-1")).resolves.toBe("wss://gw-1.sb.tenki.test/v1/ssh/session-1");
  });

  it("normalizes http(s) schemes and preserves a bridge path prefix", async () => {
    const client = fakeGatewayClient([{ healthy: true, wsBridgeEndpoint: "http://gw-1.sb.tenki.test:8443/bridge/" }]);
    await expect(discoverSSHGatewayUrl(client, "session-1")).resolves.toBe(
      "ws://gw-1.sb.tenki.test:8443/bridge/v1/ssh/session-1",
    );
  });

  it("returns empty when the RPC fails, no gateway qualifies, or session id is blank", async () => {
    const failing = {
      listActiveSSHGateways: async () => {
        throw new Error("unimplemented");
      },
    } as unknown as GatewayClient;
    await expect(discoverSSHGatewayUrl(failing, "session-1")).resolves.toBe("");
    await expect(discoverSSHGatewayUrl(fakeGatewayClient([]), "session-1")).resolves.toBe("");
    await expect(
      discoverSSHGatewayUrl(fakeGatewayClient([{ healthy: true, wsBridgeEndpoint: "not a url" }]), "session-1"),
    ).resolves.toBe("");
    await expect(
      discoverSSHGatewayUrl(fakeGatewayClient([{ healthy: true, wsBridgeEndpoint: "wss://gw-1.test" }]), "  "),
    ).resolves.toBe("");
  });

  it("connectSSH dials the discovered URL when discovery succeeds", async () => {
    const pending = connectSSH("https://sandbox-gateway.tenki.test", "session-1", "tk_test", "tenki_session", {
      discoverGateway: async () => "wss://gw-1.sb.tenki.test/v1/ssh/session-1",
    });

    await vi.waitFor(() => {
      expect(wsMock.instances.length).toBe(1);
    });
    const ws = wsMock.instances[0];
    expect(ws.url).toBe("wss://gw-1.sb.tenki.test/v1/ssh/session-1");

    ws.emit("open");
    await expect(pending).resolves.toBeDefined();
  });

  it("connectSSH falls back to the derived URL when discovery returns empty or throws", async () => {
    for (const discoverGateway of [
      async () => "",
      async () => {
        throw new Error("engine unreachable");
      },
    ]) {
      const before = wsMock.instances.length;
      const pending = connectSSH("https://sandbox-gateway.tenki.test", "session-1", "tk_test", "tenki_session", {
        discoverGateway,
      });

      await vi.waitFor(() => {
        expect(wsMock.instances.length).toBe(before + 1);
      });
      const ws = wsMock.instances[wsMock.instances.length - 1];
      expect(ws.url).toBe("wss://sandbox-gateway.tenki.test/v1/ssh/session-1");

      ws.emit("open");
      await expect(pending).resolves.toBeDefined();
    }
  });

  it("issueSandboxSSHCert maps the RPC request and response", async () => {
    const calls: unknown[] = [];
    const client = {
      issueSandboxSSHCert: async (req: unknown) => {
        calls.push(req);
        return {
          sshCert: "ssh-ed25519-cert-v01@openssh.com AAAA...",
          caPub: "ssh-ed25519 CA...",
          certSerial: "0xabc",
          expiresAt: { seconds: 1700000000n, nanos: 0 },
          renewalAfter: { seconds: 480n, nanos: 0 },
          permissions: {
            allowPty: true,
            allowAgentForwarding: false,
            allowPortForwardingLocal: true,
            allowPortForwardingRemote: false,
            allowX11Forwarding: false,
          },
        };
      },
    } as unknown as Parameters<typeof issueSandboxSSHCert>[0];

    const cert = await issueSandboxSSHCert(client, "session-1", "ssh-ed25519 AAAApub", 600_000);
    expect(calls[0]).toMatchObject({
      sessionId: "session-1",
      publicKey: "ssh-ed25519 AAAApub",
      requestedTtl: expect.objectContaining({ seconds: 600n }),
    });
    expect(cert.sshCert).toBe("ssh-ed25519-cert-v01@openssh.com AAAA...");
    expect(cert.caPub).toBe("ssh-ed25519 CA...");
    expect(cert.certSerial).toBe("0xabc");
    expect(cert.expiresAt).toEqual(new Date(1700000000 * 1000));
    expect(cert.renewalAfterMs).toBe(480_000);
    expect(cert.permissions).toEqual({
      allowPty: true,
      allowAgentForwarding: false,
      allowPortForwardingLocal: true,
      allowPortForwardingRemote: false,
      allowX11Forwarding: false,
    });
  });

  it("issueSandboxSSHCert rejects blank session or key without calling the RPC", async () => {
    const client = {
      issueSandboxSSHCert: async () => {
        throw new Error("should not be called");
      },
    } as unknown as Parameters<typeof issueSandboxSSHCert>[0];
    await expect(issueSandboxSSHCert(client, " ", "ssh-ed25519 AAAA")).rejects.toThrow("session_id required");
    await expect(issueSandboxSSHCert(client, "session-1", " ")).rejects.toThrow("public_key required");
  });

  it("threads discovery from Session.ssh()", async () => {
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
      { discoverGateway: async (sid) => `wss://gw-1.sb.tenki.test/v1/ssh/${sid}` },
    );

    const pending = session.ssh();
    await vi.waitFor(() => {
      expect(wsMock.instances.length).toBe(1);
    });
    expect(wsMock.instances[0].url).toBe("wss://gw-1.sb.tenki.test/v1/ssh/session-1");

    wsMock.instances[0].emit("open");
    await expect(pending).resolves.toBeDefined();
  });
});

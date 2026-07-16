import WebSocket from "ws";

import { setAuthHeaders } from "./auth.js";
import {
  InvalidStateError,
  PermissionDeniedError,
  SessionNotFoundError,
  SSHUnavailableError,
  UnauthorizedError,
} from "./errors.js";
import type { RootCertificates } from "./options.js";

export interface SSHConnectOptions {
  rootCertificates?: RootCertificates;
}

export class SSHConnection {
  private ws: WebSocket;
  private closed = false;
  private readBuf: Buffer[] = [];
  private readResolve: ((value: Uint8Array | null) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on("message", (data: Buffer) => {
      if (this.readResolve) {
        const resolve = this.readResolve;
        this.readResolve = null;
        resolve(new Uint8Array(data));
      } else {
        this.readBuf.push(data);
      }
    });

    ws.on("close", () => {
      this.closed = true;
      if (this.readResolve) {
        const resolve = this.readResolve;
        this.readResolve = null;
        resolve(null);
      }
    });

    ws.on("error", () => {
      this.closed = true;
      if (this.readResolve) {
        const resolve = this.readResolve;
        this.readResolve = null;
        resolve(null);
      }
    });
  }

  async read(): Promise<Uint8Array | null> {
    if (this.readBuf.length > 0) {
      return new Uint8Array(this.readBuf.shift()!);
    }
    if (this.closed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.readResolve = resolve;
    });
  }

  async write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(data, (err) => {
        if (err) reject(new SSHUnavailableError(err.message, { cause: err }));
        else resolve();
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000, "");
    } catch {
      // ignore
    }
  }
}

export function deriveGatewayAddress(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return "";
  }
  if (!u.hostname) return "";

  let host = u.hostname;
  if (host.startsWith("api.")) {
    host = "sandbox-gateway." + host.slice(4);
  } else if (host.startsWith("app.")) {
    host = "sandbox-gateway." + host.slice(4);
  } else {
    host = "sandbox-gateway." + host;
  }

  const port = u.port;
  u.hostname = host;
  if (port) u.port = port;
  u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

export function gatewaySSHUrl(gatewayAddress: string, sessionId: string): string {
  if (!gatewayAddress.trim() || !sessionId.trim()) return "";
  let u: URL;
  try {
    u = new URL(gatewayAddress.trim());
  } catch {
    return "";
  }

  u.pathname = `/v1/ssh/${sessionId}`;
  u.search = "";
  u.hash = "";

  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";

  return u.toString();
}

export async function connectSSH(
  gatewayAddress: string,
  sessionId: string,
  authToken: string,
  cookieName: string,
  options?: SSHConnectOptions,
): Promise<SSHConnection> {
  const url = gatewaySSHUrl(gatewayAddress, sessionId);
  if (!url) {
    throw new SSHUnavailableError("gateway address not configured");
  }

  const headers: Record<string, string> = {};
  const h = new Headers();
  setAuthHeaders(h, authToken, cookieName);
  h.forEach((value, key) => {
    headers[key] = value;
  });

  return new Promise<SSHConnection>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers,
      ca: options?.rootCertificates,
    });

    ws.on("open", () => {
      resolve(new SSHConnection(ws));
    });

    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        const reason = body.trim() || res.statusMessage || "unknown";
        switch (res.statusCode) {
          case 401:
            reject(new UnauthorizedError(reason));
            break;
          case 403:
            reject(new PermissionDeniedError(reason));
            break;
          case 404:
            reject(new SessionNotFoundError(reason));
            break;
          case 409:
            reject(new InvalidStateError(reason));
            break;
          default:
            reject(new SSHUnavailableError(reason));
        }
      });
    });

    ws.on("error", (err) => {
      reject(new SSHUnavailableError(err.message, { cause: err }));
    });
  });
}

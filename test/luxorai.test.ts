import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAuthToken, setAuthHeaders } from "../src/auth.js";
import { closeDataPlaneConnection, createDataPlaneClient, DataPlaneCredentialManager } from "../src/data-plane.js";
import { InvalidAuthTokenError, MissingAuthTokenError } from "../src/errors.js";
import { LuxorSandbox, TenkiSandbox, WorkspaceClient } from "../src/index.js";
import * as workspacePb from "../src/internal/proto/tenki/cloud/workspace/v1beta1/secrets_pb.js";
import {
  SandboxSessionDataPlaneService,
  SessionCredentialSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { deriveGatewayAddress } from "../src/ssh.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const ENV_NAMES = [
  "LUXORAI_AUTH_TOKEN",
  "LUXORAI_API_KEY",
  "LUXORAI_API_ENDPOINT",
  "LUXORAI_API_URL",
  "LUXORAI_SANDBOX_GATEWAY_URL",
  "LUXORAI_CLOUD_API_URL",
  "TENKI_AUTH_TOKEN",
  "TENKI_API_KEY",
  "TENKI_API_ENDPOINT",
  "TENKI_API_URL",
  "TENKI_SANDBOX_GATEWAY_URL",
  "TENKI_CLOUD_API_URL",
];

const saved = { ...process.env };
beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});
afterEach(() => {
  process.env = { ...saved };
});

function clientConfig(client: TenkiSandbox): { baseUrl: string; gatewayAddress: string } {
  return client as unknown as { baseUrl: string; gatewayAddress: string };
}

describe("LUXORAI_* environment", () => {
  it("prefers LUXORAI_* over TENKI_* for the auth token", () => {
    process.env.TENKI_AUTH_TOKEN = "tk_tenki_auth";
    process.env.TENKI_API_KEY = "tk_tenki_key";
    process.env.LUXORAI_API_KEY = "lx_luxorai_key";
    expect(resolveAuthToken()).toBe("lx_luxorai_key");
    process.env.LUXORAI_AUTH_TOKEN = "lx_luxorai_auth";
    expect(resolveAuthToken()).toBe("lx_luxorai_auth");
  });

  it("falls back to TENKI_* when no LUXORAI_* token is set", () => {
    process.env.TENKI_API_KEY = "tk_tenki_key";
    expect(resolveAuthToken()).toBe("tk_tenki_key");
  });

  it("falls back to TENKI_* when LUXORAI_AUTH_TOKEN is whitespace", () => {
    process.env.LUXORAI_AUTH_TOKEN = " \t ";
    process.env.TENKI_AUTH_TOKEN = "tk_tenki_auth";
    expect(resolveAuthToken()).toBe("tk_tenki_auth");
  });

  it("prefers LUXORAI_* base and gateway URLs", () => {
    process.env.TENKI_API_ENDPOINT = "https://api.tenki.example";
    process.env.TENKI_SANDBOX_GATEWAY_URL = "wss://gateway.tenki.example";
    process.env.LUXORAI_API_URL = "https://api.luxor.example";
    process.env.LUXORAI_SANDBOX_GATEWAY_URL = "wss://gateway.luxor.example";
    const client = new LuxorSandbox({ authToken: "lx_test", transport: {} as never });
    expect(clientConfig(client)).toMatchObject({
      baseUrl: "https://api.luxor.example",
      gatewayAddress: "wss://gateway.luxor.example",
    });
  });

  it("falls back to TENKI_* base and gateway URLs", () => {
    process.env.TENKI_API_URL = "https://api.tenki.example";
    process.env.TENKI_SANDBOX_GATEWAY_URL = "wss://gateway.tenki.example";
    const client = new TenkiSandbox({ authToken: "tk_test", transport: {} as never });
    expect(clientConfig(client)).toMatchObject({
      baseUrl: "https://api.tenki.example",
      gatewayAddress: "wss://gateway.tenki.example",
    });
  });

  it("derives the gateway from a LUXORAI_API_ENDPOINT on api.luxor.ai", () => {
    process.env.LUXORAI_API_ENDPOINT = "https://api.luxor.ai";
    process.env.LUXORAI_API_URL = "https://ignored.luxor.example";
    const client = new LuxorSandbox({ authToken: "lx_test", transport: {} as never });
    expect(clientConfig(client)).toMatchObject({
      baseUrl: "https://api.luxor.ai",
      gatewayAddress: "https://sandbox-gateway.luxor.ai",
    });
    expect(deriveGatewayAddress("https://api.luxor.ai")).toBe("https://sandbox-gateway.luxor.ai");
  });
});

describe("lx_ API keys", () => {
  it.each(["lx_key", "lx_svc_token", "tk_key", "tk_svc_token"])("accepts %s", (token) => {
    expect(resolveAuthToken(token)).toBe(token);
  });

  it("names LUXORAI_* first and both key prefixes in auth errors", () => {
    expect(() => resolveAuthToken()).toThrow(MissingAuthTokenError);
    expect(new MissingAuthTokenError().message).toMatch(/LUXORAI_AUTH_TOKEN.*\(or TENKI_AUTH_TOKEN/);
    expect(() => resolveAuthToken("lxr_token")).toThrow(InvalidAuthTokenError);
    expect(new InvalidAuthTokenError().message).toContain("lx_ or tk_");
  });

  it("exports LuxorSandbox as the same class as TenkiSandbox", () => {
    expect(LuxorSandbox).toBe(TenkiSandbox);
    expect(new LuxorSandbox({ authToken: "lx_svc_test", transport: {} as never })).toBeInstanceOf(TenkiSandbox);
  });
});

describe("SDK identity headers", () => {
  it("sets x-luxor-sdk and leads the User-Agent with the SDK", () => {
    const headers = new Headers({ "User-Agent": "connect-es/2.1.2" });
    setAuthHeaders(headers, "lx_test");
    expect(headers.get("x-luxor-sdk")).toBe(`typescript/${version}`);
    expect(headers.get("user-agent")).toBe(`luxor-sandbox-typescript/${version} connect-es/2.1.2`);
    setAuthHeaders(headers, "lx_test");
    expect(headers.get("user-agent")).toBe(`luxor-sandbox-typescript/${version} connect-es/2.1.2`);
  });

  it("sends the SDK header on workspace requests and reads LUXORAI_CLOUD_API_URL first", async () => {
    const seen: Array<{ authorization: string | null; sdk: string | null; userAgent: string | null }> = [];
    const server = createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(workspacePb.WorkspaceSecretsService, {
            getSecret(_request, context) {
              seen.push({
                authorization: context.requestHeader.get("authorization"),
                sdk: context.requestHeader.get("x-luxor-sdk"),
                userAgent: context.requestHeader.get("user-agent"),
              });
              return { secret: { id: "secret" } };
            },
          });
        },
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    process.env.TENKI_CLOUD_API_URL = "http://127.0.0.1:1";
    process.env.LUXORAI_CLOUD_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.TENKI_AUTH_TOKEN = "tk_tenki";
    process.env.LUXORAI_AUTH_TOKEN = "lx_luxorai";
    const client = new WorkspaceClient();
    try {
      await client.secrets.get("secret");
      expect(seen).toEqual([
        {
          authorization: "Bearer lx_luxorai",
          sdk: `typescript/${version}`,
          userAgent: expect.stringMatching(/^luxor-sandbox-typescript\//),
        },
      ]);
    } finally {
      await client.close();
      server.close();
    }
  });

  it("sends the SDK header on data-plane requests", async () => {
    const seen: Array<string | null> = [];
    const server = createServer(
      connectNodeAdapter({
        routes(router) {
          router.service(SandboxSessionDataPlaneService, {
            stat(_request, context) {
              seen.push(context.requestHeader.get("x-luxor-sdk"));
              return { response: {} };
            },
          });
        },
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const credentials = new DataPlaneCredentialManager(
      { renewDataPlaneCredential: vi.fn(async () => true) } as never,
      create(SessionCredentialSchema, {
        credential: "cred",
        expiresAt: timestampFromDate(new Date(Date.now() + 3_600_000)),
      }),
      endpoint,
    );
    const client = createDataPlaneClient(endpoint, credentials, "session-1");
    try {
      await client.stat({ request: { sessionId: "session-1", path: "/" } } as never);
      expect(seen).toEqual([`typescript/${version}`]);
    } finally {
      closeDataPlaneConnection(client);
      server.close();
    }
  });
});

import { inspect } from "node:util";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { DataPlaneCredentialManager } from "../src/data-plane.js";
import { TemplateRuntimeFailedError, WaitReadyFailedError } from "../src/errors.js";
import { SandboxSessionSchema, SessionCredentialSchema } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";
import { WorkspaceClient } from "../src/workspace.js";

describe("credential privacy", () => {
  it("keeps auth tokens out of session and readiness error inspection", () => {
    const token = "tk_dummy-auth-token-private";
    const client = new TenkiSandbox({ authToken: token, baseUrl: "http://127.0.0.1:8090" });
    const session = new Session(
      {} as ConstructorParameters<typeof Session>[0],
      create(SandboxSessionSchema, { id: "session-privacy" }),
      token,
      "http://127.0.0.1:8090",
    );
    try {
      const errors = [
        new WaitReadyFailedError("timed out", session),
        new TemplateRuntimeFailedError("failed", session),
      ];
      for (const value of [client, session, ...errors]) {
        expect(inspect(value, { depth: null, showHidden: true })).not.toContain(token);
        expect(Object.values(value)).not.toContain(token);
      }
      expect(errors[0].session.id).toBe("session-privacy");
    } finally {
      client.close();
    }
  });

  it("keeps auth tokens and live session credentials out of every rendering", async () => {
    const token = "tk_dummy-auth-token-private";
    const credential = "dummy-session-credential-private";
    const client = new TenkiSandbox({ authToken: token, baseUrl: "http://127.0.0.1:8090" });
    const workspace = new WorkspaceClient({ authToken: token, baseUrl: "http://127.0.0.1:8090" });
    const session = new Session(
      {} as ConstructorParameters<typeof Session>[0],
      create(SandboxSessionSchema, { id: "session-privacy" }),
      token,
      "http://127.0.0.1:8090",
      undefined,
      60_000,
      { credential: create(SessionCredentialSchema, { credential }) },
    );
    try {
      for (const value of [client, workspace, session]) {
        const rendered = [
          inspect(value, { depth: null, showHidden: true }),
          String(value),
          JSON.stringify(value),
          JSON.stringify(Object.entries(value)),
        ].join("\n");
        expect(rendered).not.toContain(token);
        expect(rendered).not.toContain(credential);
      }
      expect(JSON.stringify(session)).toContain("session-privacy");
      expect(JSON.stringify(client)).toBe('{"baseUrl":"http://127.0.0.1:8090","authToken":"[REDACTED]"}');
      expect(inspect(client)).toBe('TenkiSandbox { baseUrl: "http://127.0.0.1:8090", authToken: [REDACTED] }');
    } finally {
      client.close();
      await workspace.close();
    }
  });

  it("keeps session credentials out of diagnostic output", () => {
    const token = "dummy-session-credential-private";
    const manager = new DataPlaneCredentialManager(
      {} as Session,
      create(SessionCredentialSchema, { credential: token }),
    );
    try {
      expect(manager.current()).toBe(token);
      expect(inspect(manager, { depth: null, showHidden: true })).not.toContain(token);
      expect(JSON.stringify(manager)).not.toContain(token);
    } finally {
      manager.stop();
    }
  });
});

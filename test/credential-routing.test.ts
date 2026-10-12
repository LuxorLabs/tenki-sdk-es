import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { createDataPlaneClient, DataPlaneCredentialManager } from "../src/data-plane.js";
import {
  SandboxSessionSchema,
  SessionCredentialSchema,
  SessionState,
  TerminateSessionResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

// CLO-5016. A data-plane credential authorizes one session on one node, so the
// SDK must refuse to attach it to a request aimed anywhere else, and a session
// that has been closed must not re-arm its renewal or its transport.

const NODE_A = "https://node-a.sandbox.test";
const NODE_B = "https://node-b.sandbox.test";

function credential(value: string) {
  return create(SessionCredentialSchema, {
    credential: value,
    expiresAt: timestampFromDate(new Date(Date.now() + 3_600_000)),
  });
}

function credentialManager(value: string, endpoint: string): DataPlaneCredentialManager {
  // renewDataPlaneCredential is never reached: every case below is refused
  // before the request leaves the process.
  const session = { renewDataPlaneCredential: vi.fn(async () => true) } as never;
  return new DataPlaneCredentialManager(session, credential(value), endpoint);
}

describe("data-plane credential routing", () => {
  it("refuses to send a credential minted for another endpoint", async () => {
    const credentials = credentialManager("cred-for-node-B", NODE_B);
    const client = createDataPlaneClient(NODE_A, credentials, "session-1");

    await expect(
      client.stat({ request: { sessionId: "session-1", path: "/home/tenki" } } as never),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectError &&
        err.code === Code.PermissionDenied &&
        err.message.includes("minted for another endpoint"),
    );
  });

  it("refuses a request that names another session", async () => {
    const credentials = credentialManager("cred-for-node-A", NODE_A);
    const client = createDataPlaneClient(NODE_A, credentials, "session-1");

    await expect(
      client.stat({ request: { sessionId: "session-2", path: "/home/tenki" } } as never),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ConnectError &&
        err.code === Code.PermissionDenied &&
        err.message.includes("targets session session-2"),
    );
  });

  it("attaches a credential minted for the endpoint it is sent to", async () => {
    const credentials = credentialManager("cred-for-node-A", NODE_A);
    const current = credentials.currentFor(NODE_A);

    expect(current.bound).toBe(true);
    expect(current.bound && current.credential).toBe("cred-for-node-A");
  });

  it("binds an unbound credential to the first endpoint that adopts it", () => {
    const credentials = credentialManager("cred-unbound", "");

    expect(credentials.currentFor(NODE_A).bound).toBe(false);
    credentials.adoptEndpoint(NODE_A);
    expect(credentials.currentFor(NODE_A).bound).toBe(true);
    // Adoption happens once; another node does not inherit it.
    credentials.adoptEndpoint(NODE_B);
    expect(credentials.currentFor(NODE_B).bound).toBe(false);
  });
});

describe("Session.close", () => {
  function makeSession() {
    const terminateSession = vi.fn(async () =>
      create(TerminateSessionResponseSchema, {
        session: create(SandboxSessionSchema, {
          id: "session-1",
          state: SessionState.TERMINATED,
          ownerType: "SERVICE",
          ownerId: "self",
        }),
      }),
    );
    const rpcClient = { terminateSession } as never;
    const proto = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
    });
    const session = new Session(rpcClient, proto, "tk_test", "wss://gateway.tenki.test");
    return { session, terminateSession };
  }

  it("terminates once under concurrent callers", async () => {
    const { session, terminateSession } = makeSession();

    await Promise.all(Array.from({ length: 8 }, () => session.close()));

    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it("stays a no-op after it has terminated", async () => {
    const { session, terminateSession } = makeSession();

    await session.close();
    await session.close();

    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it("does not re-arm the data plane for a response that lands after close", async () => {
    const { session } = makeSession();
    await session.close();

    // A renewal in flight across close resolves afterwards and would otherwise
    // rebuild the credential manager and a pooled transport.
    (session as never as { applyDataPlaneResponse: (e?: string, c?: unknown) => void }).applyDataPlaneResponse(
      NODE_A,
      credential("cred-late"),
    );

    expect(session.dataPlaneRPC()).toBeUndefined();
    expect((session as never as { dataPlaneCredential?: unknown }).dataPlaneCredential).toBeUndefined();
  });

  it("stays retryable when terminate fails", async () => {
    const terminateSession = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError("engine unavailable", Code.Unavailable))
      .mockResolvedValueOnce(
        create(TerminateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.TERMINATED,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      );
    const proto = create(SandboxSessionSchema, {
      id: "session-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
    });
    const session = new Session({ terminateSession } as never, proto, "tk_test", "wss://gateway.tenki.test");

    await expect(session.close()).rejects.toThrow();
    await expect(session.close()).resolves.toBeUndefined();
    expect(terminateSession).toHaveBeenCalledTimes(2);
  });
});

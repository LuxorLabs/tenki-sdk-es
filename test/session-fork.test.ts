import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";

import { ForkFailedError, QuotaExceededError, SessionNotFoundError } from "../src/errors.js";
import {
  ForkSessionResponseSchema,
  SandboxSessionSchema,
  SessionState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

function child(id: string, name: string) {
  return create(SandboxSessionSchema, {
    id,
    name,
    state: SessionState.CREATING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
}

function makeSource(forkSession: ReturnType<typeof vi.fn>): Session {
  return new Session(
    { forkSession } as never,
    create(SandboxSessionSchema, {
      id: "source-1",
      state: SessionState.RUNNING,
      ownerType: "SERVICE",
      ownerId: "self",
    }),
    "tk_test",
    "wss://gateway.tenki.test",
  );
}

describe("Session.fork", () => {
  it("sends the fork options and returns the children as sessions", async () => {
    const forkSession = vi.fn(async () =>
      create(ForkSessionResponseSchema, {
        snapshotId: "snap-1",
        sessions: [child("child-1", "eval-1"), child("child-2", "eval-2")],
      }),
    );

    const children = await makeSource(forkSession).fork({ count: 2, namePrefix: "eval", wait: true });

    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "source-1", count: 2, namePrefix: "eval", wait: true }),
    );
    expect(children.map((s) => s.id)).toEqual(["child-1", "child-2"]);
    expect(children[1]).toBeInstanceOf(Session);
    expect(children[1]?.name).toBe("eval-2");
    expect(children[0]?.state).toBe("CREATING");
  });

  it("leaves unset options to the server defaults", async () => {
    const forkSession = vi.fn(async () => create(ForkSessionResponseSchema, { snapshotId: "snap-1" }));

    await makeSource(forkSession).fork();

    expect(forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "source-1", count: 0, namePrefix: "", wait: false }),
    );
  });

  it("throws ForkFailedError with the snapshot and the children created before a failure", async () => {
    const forkSession = vi.fn(async () => {
      throw new ConnectError("workspace concurrent session quota exceeded", Code.ResourceExhausted, undefined, [
        {
          desc: ForkSessionResponseSchema,
          value: { snapshotId: "snap-9", sessions: [child("child-1", "web-fork-1")] },
        },
      ]);
    });

    const err = await makeSource(forkSession)
      .fork({ count: 3 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForkFailedError);
    const forkErr = err as ForkFailedError;
    expect(forkErr.snapshotId).toBe("snap-9");
    expect(forkErr.sessions.map((s) => s.id)).toEqual(["child-1"]);
    expect(forkErr.cause).toBeInstanceOf(QuotaExceededError);
  });

  it("maps a rejection without a snapshot like any other call", async () => {
    const forkSession = vi.fn(async () => {
      throw new ConnectError("session not found", Code.NotFound);
    });

    await expect(makeSource(forkSession).fork()).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { SnapshotFailedError, SnapshotWaitTimeoutError } from "../src/errors.js";
import {
  CreateSnapshotResponseSchema,
  GetSnapshotResponseSchema,
  ListDanglingSnapshotsResponseSchema,
  ListSessionSnapshotsResponseSchema,
  SnapshotSchema,
  SnapshotState,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("Snapshot client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists session snapshots", async () => {
    const client = makeClient({
      listSessionSnapshots: vi.fn(async (req: { sessionId: string; pageSize: number }) => {
        expect(req.sessionId).toBe("sess-001");
        expect(req.pageSize).toBe(100);
        return create(ListSessionSnapshotsResponseSchema, {
          snapshots: [create(SnapshotSchema, { id: "snap-001", sessionId: "sess-001" })],
        });
      }),
    });

    const snapshots = await client.listSessionSnapshots(" sess-001 ");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.id).toBe("snap-001");
    expect(snapshots[0]?.sessionId).toBe("sess-001");
  });

  it("lists dangling snapshots", async () => {
    const listDanglingSnapshots = vi.fn(async (req: { pageSize: number }) => {
      expect(req.pageSize).toBe(100);
      return create(ListDanglingSnapshotsResponseSchema, {
        snapshots: [create(SnapshotSchema, { id: "snap-001", sessionId: "sess-001" })],
      });
    });
    const client = makeClient({ listDanglingSnapshots });

    const snapshots = await client.listDanglingSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.id).toBe("snap-001");
    expect(listDanglingSnapshots).toHaveBeenCalledTimes(1);
  });

  it("creates a snapshot asynchronously", async () => {
    const createSnapshot = vi.fn(async (req: { sessionId: string; async: boolean }) => {
      expect(req.sessionId).toBe("sess-001");
      expect(req.async).toBe(true);
      return create(CreateSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { id: "snap-001", sessionId: "sess-001" }),
      });
    });
    const client = makeClient({ createSnapshot });

    const snapshot = await client.createSnapshotAsync("sess-001");

    expect(snapshot.id).toBe("snap-001");
    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });

  it("creates a snapshot asynchronously before waiting for ready", async () => {
    const createSnapshot = vi.fn(async (req: { sessionId: string; async: boolean }) => {
      expect(req.async).toBe(true);
      return create(CreateSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { id: "snap-001", sessionId: req.sessionId, state: SnapshotState.CREATING }),
      });
    });
    const getSnapshot = vi.fn(async () =>
      create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { id: "snap-001", sessionId: "sess-001", state: SnapshotState.READY }),
      }),
    );
    const client = makeClient({ createSnapshot, getSnapshot });

    const snapshot = await client.createSnapshotAndWait("sess-001", { timeoutMs: 60_000 });

    expect(snapshot.id).toBe("snap-001");
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalled();
  });

  it("reports the failure reason when the snapshot fails", async () => {
    const getSnapshot = vi.fn(async () =>
      create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, {
          id: "snap-001",
          state: SnapshotState.FAILED,
          failureReason: "rootfs capture failed",
        }),
      }),
    );
    const client = makeClient({ getSnapshot });

    const err = await client.waitSnapshotReady("snap-001", 60_000).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SnapshotFailedError);
    expect((err as SnapshotFailedError).failureReason).toBe("rootfs capture failed");
    expect((err as Error).message).toContain("rootfs capture failed");
  });

  it("explains how to keep waiting when the wait times out", async () => {
    const getSnapshot = vi.fn(async () =>
      create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { id: "snap-001", state: SnapshotState.CREATING }),
      }),
    );
    const client = makeClient({ getSnapshot });

    const err = await client.waitSnapshotReady("snap-001", 10).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SnapshotWaitTimeoutError);
    expect((err as Error).message).toContain('waitSnapshotReady("snap-001")');
  });
});

function makeClient(overrides: Record<string, unknown>): TenkiSandbox {
  const client = Object.create(TenkiSandbox.prototype) as TenkiSandbox & { rpcClient: Record<string, unknown> };
  client.rpcClient = {
    listSessionSnapshots: vi.fn(),
    listDanglingSnapshots: vi.fn(),
    ...overrides,
  };
  return client;
}

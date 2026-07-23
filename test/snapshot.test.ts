import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  CreateSnapshotResponseSchema,
  ListDanglingSnapshotsResponseSchema,
  ListSessionSnapshotsResponseSchema,
  SnapshotSchema,
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

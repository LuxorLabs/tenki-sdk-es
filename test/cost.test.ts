import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  BatchGetSessionCostsResponseSchema,
  GetSessionCostResponseSchema,
  SessionCostItem,
  SessionCostLineSchema,
  SessionCostSchema,
  SessionCostStatus,
  SessionCostUnit,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

type TestClient = TenkiSandbox & { rpcClient: Record<string, unknown> };

function clientWith(rpcClient: Record<string, unknown>): TestClient {
  const client = Object.create(TenkiSandbox.prototype) as TestClient;
  client.rpcClient = rpcClient;
  return client;
}

describe("getSessionCost", () => {
  it("maps every field of a final cost", async () => {
    const startedAt = new Date("2026-11-24T09:00:00Z");
    const endedAt = new Date("2026-11-24T10:00:00Z");
    const line = (item: SessionCostItem, unit: SessionCostUnit, quantity: string, amountUsd: string) =>
      create(SessionCostLineSchema, {
        item,
        quantity,
        unit,
        amountUsd,
        startedAt: timestampFromDate(startedAt),
        endedAt: timestampFromDate(endedAt),
      });
    const getSessionCost = vi.fn(async () =>
      create(GetSessionCostResponseSchema, {
        cost: create(SessionCostSchema, {
          sessionId: "session-1",
          status: SessionCostStatus.FINAL,
          totalUsd: "0.1234",
          lines: [
            line(SessionCostItem.CPU, SessionCostUnit.VCPU_SECOND, "7200", "0.1"),
            line(SessionCostItem.MEMORY, SessionCostUnit.GIB_SECOND, "14400.5", "0.02"),
            line(SessionCostItem.DISK, SessionCostUnit.GIB_SECOND, "36000", "0.003"),
            line(SessionCostItem.PAUSED_STORAGE, SessionCostUnit.GIB_SECOND, "1200", "0.0004"),
          ],
          asOf: timestampFromDate(endedAt),
          billedRunningSeconds: 3600n,
          billedPausedSeconds: 120n,
        }),
      }),
    );

    const cost = await clientWith({ getSessionCost }).getSessionCost(" session-1 ");

    expect(getSessionCost).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    expect(cost).toEqual({
      sessionId: "session-1",
      status: "FINAL",
      totalUsd: "0.1234",
      lines: [
        { item: "CPU", quantity: "7200", unit: "VCPU_SECOND", amountUsd: "0.1", startedAt, endedAt },
        { item: "MEMORY", quantity: "14400.5", unit: "GIB_SECOND", amountUsd: "0.02", startedAt, endedAt },
        { item: "DISK", quantity: "36000", unit: "GIB_SECOND", amountUsd: "0.003", startedAt, endedAt },
        { item: "PAUSED_STORAGE", quantity: "1200", unit: "GIB_SECOND", amountUsd: "0.0004", startedAt, endedAt },
      ],
      asOf: endedAt,
      billedRunningSeconds: 3600,
      billedPausedSeconds: 120,
    });
  });

  it("keeps unset optional fields undefined while accruing", async () => {
    const startedAt = new Date("2026-11-24T09:00:00Z");
    const getSessionCost = vi.fn(async () =>
      create(GetSessionCostResponseSchema, {
        cost: create(SessionCostSchema, {
          sessionId: "session-1",
          status: SessionCostStatus.ACCRUING,
          lines: [
            create(SessionCostLineSchema, {
              item: SessionCostItem.CPU,
              quantity: "0",
              unit: SessionCostUnit.VCPU_SECOND,
              amountUsd: "0",
              startedAt: timestampFromDate(startedAt),
            }),
          ],
        }),
      }),
    );

    const cost = await clientWith({ getSessionCost }).getSessionCost("session-1");

    expect(cost.status).toBe("ACCRUING");
    expect(cost.totalUsd).toBeUndefined();
    expect(cost.asOf).toBeUndefined();
    expect(cost.billedRunningSeconds).toBe(0);
    expect(cost.billedPausedSeconds).toBe(0);
    expect(cost.lines[0]!.startedAt).toEqual(startedAt);
    expect(cost.lines[0]!.endedAt).toBeUndefined();
  });

  it("distinguishes a zero total from an unset one", async () => {
    const getSessionCost = vi.fn(async () =>
      create(GetSessionCostResponseSchema, {
        cost: create(SessionCostSchema, { sessionId: "session-1", status: SessionCostStatus.FINAL, totalUsd: "0" }),
      }),
    );

    const cost = await clientWith({ getSessionCost }).getSessionCost("session-1");

    expect(cost.totalUsd).toBe("0");
    expect(cost.lines).toEqual([]);
  });

  it("maps unavailable and unknown enum values", async () => {
    const getSessionCost = vi
      .fn()
      .mockResolvedValueOnce(
        create(GetSessionCostResponseSchema, {
          cost: create(SessionCostSchema, { sessionId: "session-1", status: SessionCostStatus.UNAVAILABLE }),
        }),
      )
      .mockResolvedValueOnce(
        create(GetSessionCostResponseSchema, {
          cost: create(SessionCostSchema, {
            sessionId: "session-1",
            status: 99 as SessionCostStatus,
            lines: [create(SessionCostLineSchema, { item: 99 as SessionCostItem, unit: 99 as SessionCostUnit })],
          }),
        }),
      );
    const client = clientWith({ getSessionCost });

    expect((await client.getSessionCost("session-1")).status).toBe("UNAVAILABLE");
    const unknown = await client.getSessionCost("session-1");
    expect(unknown.status).toBe("UNSPECIFIED");
    expect(unknown.lines[0]).toMatchObject({ item: "UNSPECIFIED", unit: "UNSPECIFIED" });
    expect(unknown.lines[0]!.startedAt).toBeUndefined();
  });

  it("tolerates a response without a cost", async () => {
    const getSessionCost = vi.fn(async () => create(GetSessionCostResponseSchema));

    const cost = await clientWith({ getSessionCost }).getSessionCost("session-1");

    expect(cost).toEqual({
      sessionId: "session-1",
      status: "UNSPECIFIED",
      totalUsd: undefined,
      lines: [],
      asOf: undefined,
      billedRunningSeconds: 0,
      billedPausedSeconds: 0,
    });
  });

  it("reads cost from a session handle", async () => {
    const getSessionCost = vi.fn(async () =>
      create(GetSessionCostResponseSchema, {
        cost: create(SessionCostSchema, { sessionId: "session-1", status: SessionCostStatus.ACCRUING }),
      }),
    );
    const session = Object.create(Session.prototype) as Session & { rpcClient: Record<string, unknown>; id: string };
    session.rpcClient = { getSessionCost };
    session.id = "session-1";

    const cost = await session.cost();

    expect(getSessionCost).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    expect(cost.status).toBe("ACCRUING");
  });
});

describe("batchGetSessionCosts", () => {
  it("returns costs and missing session IDs", async () => {
    const batchGetSessionCosts = vi.fn(async () =>
      create(BatchGetSessionCostsResponseSchema, {
        costs: [
          create(SessionCostSchema, { sessionId: "session-1", status: SessionCostStatus.FINAL, totalUsd: "1.5" }),
          create(SessionCostSchema, { sessionId: "session-2", status: SessionCostStatus.ACCRUING }),
        ],
        missingSessionIds: ["session-3"],
      }),
    );

    const batch = await clientWith({ batchGetSessionCosts }).batchGetSessionCosts([
      "session-1",
      " session-2 ",
      "session-3",
    ]);

    expect(batchGetSessionCosts).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "", sessionIds: ["session-1", "session-2", "session-3"] }),
    );
    expect(batch.costs.map((cost) => [cost.sessionId, cost.status, cost.totalUsd])).toEqual([
      ["session-1", "FINAL", "1.5"],
      ["session-2", "ACCRUING", undefined],
    ]);
    expect(batch.missingSessionIds).toEqual(["session-3"]);
  });

  it("sends an explicit workspace scope", async () => {
    const batchGetSessionCosts = vi.fn(async () => create(BatchGetSessionCostsResponseSchema));

    const batch = await clientWith({ batchGetSessionCosts }).batchGetSessionCosts(["session-1"], {
      workspaceId: " workspace-1 ",
    });

    expect(batchGetSessionCosts).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" }));
    expect(batch).toEqual({ costs: [], missingSessionIds: [] });
  });
});

import { create } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  GetSessionMetricsResponseSchema,
  SessionCPUUsageAverageSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

describe("getSessionMetrics", () => {
  it("maps optional averages and sends a custom window", async () => {
    const getSessionMetrics = vi.fn(async () =>
      create(GetSessionMetricsResponseSchema, {
        sessionId: "session-1",
        requestedWindow: durationFromMs(300_250),
        cpu: create(SessionCPUUsageAverageSchema, {
          limitCores: 2,
          sampleCount: 3n,
          observedDuration: durationFromMs(60_500),
        }),
      }),
    );
    const client = Object.create(TenkiSandbox.prototype) as TenkiSandbox & { rpcClient: Record<string, unknown> };
    client.rpcClient = { getSessionMetrics };

    const metrics = await client.getSessionMetrics("session-1", 300_250);

    expect(getSessionMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        window: expect.objectContaining({ seconds: 300n, nanos: 250_000_000 }),
      }),
    );
    expect(metrics.requestedWindowMs).toBe(300_250);
    expect(metrics.cpu.averageCores).toBeUndefined();
    expect(metrics.cpu.sampleCount).toBe(3);
    expect(metrics.cpu.observedDurationMs).toBe(60_500);
  });

  it("sends an explicit negative window for server validation", async () => {
    const getSessionMetrics = vi.fn(async () => create(GetSessionMetricsResponseSchema, { sessionId: "session-1" }));
    const client = Object.create(TenkiSandbox.prototype) as TenkiSandbox & { rpcClient: Record<string, unknown> };
    client.rpcClient = { getSessionMetrics };

    await client.getSessionMetrics("session-1", -60_000);

    expect(getSessionMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ window: expect.objectContaining({ seconds: -60n }) }),
    );
  });

  it("reads metrics from a session handle", async () => {
    const getSessionMetrics = vi.fn(async () => create(GetSessionMetricsResponseSchema, { sessionId: "session-1" }));
    const session = Object.create(Session.prototype) as Session & { rpcClient: Record<string, unknown>; id: string };
    session.rpcClient = { getSessionMetrics };
    session.id = "session-1";

    await session.metrics();

    expect(getSessionMetrics).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
  });
});

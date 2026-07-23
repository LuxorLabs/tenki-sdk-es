import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  GetWorkspaceSandboxUsageResponseSchema,
  SandboxUsageUnit,
  WorkspaceSandboxUsageLimitSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("getUsage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("infers the workspace and maps each usage limit (int64 -> number, enum -> string)", async () => {
    const getWorkspaceSandboxUsage = vi.fn(async (req: { workspaceId: string }) => {
      expect(req.workspaceId).toBe("");
      return create(GetWorkspaceSandboxUsageResponseSchema, {
        limits: [
          create(WorkspaceSandboxUsageLimitSchema, {
            key: "active_sessions",
            label: "Active sessions",
            unit: SandboxUsageUnit.COUNT,
            current: 5n,
            max: 5n,
            helpText: "Paused sessions are excluded.",
          }),
        ],
      });
    });
    const client = makeClient({ getWorkspaceSandboxUsage });

    const usage = await client.getUsage();

    expect(getWorkspaceSandboxUsage).toHaveBeenCalledTimes(1);
    expect(usage).toEqual([
      {
        key: "active_sessions",
        label: "Active sessions",
        unit: "count",
        current: 5,
        max: 5,
        helpText: "Paused sessions are excluded.",
      },
    ]);
  });

  it("leaves max undefined when the limit is unset (unlimited)", async () => {
    const client = makeClient({
      getWorkspaceSandboxUsage: vi.fn(async () =>
        create(GetWorkspaceSandboxUsageResponseSchema, {
          limits: [
            create(WorkspaceSandboxUsageLimitSchema, {
              key: "snapshots",
              label: "Snapshots",
              unit: SandboxUsageUnit.COUNT,
              current: 2n,
              helpText: "",
            }),
          ],
        }),
      ),
    });

    const usage = await client.getUsage();

    expect(usage[0]?.current).toBe(2);
    expect(usage[0]?.max).toBeUndefined();
  });
});

function makeClient(overrides: Record<string, unknown>): TenkiSandbox {
  const client = Object.create(TenkiSandbox.prototype) as TenkiSandbox & {
    rpcClient: Record<string, unknown>;
  };
  client.rpcClient = {
    getWorkspaceSandboxUsage: vi.fn(),
    ...overrides,
  };
  return client;
}

import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  GetWorkspaceSandboxUsageResponseSchema,
  SandboxUsageUnit,
  WorkspaceSandboxUsageLimitSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("getWorkspaceSandboxUsage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trims the workspace id and maps each usage limit (int64 -> number, enum -> string)", async () => {
    const getWorkspaceSandboxUsage = vi.fn(async (req: { workspaceId: string }) => {
      expect(req.workspaceId).toBe("ws-001");
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

    const usage = await client.getWorkspaceSandboxUsage(" ws-001 ");

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

    const usage = await client.getWorkspaceSandboxUsage("ws-001");

    expect(usage[0]?.current).toBe(2);
    expect(usage[0]?.max).toBeUndefined();
  });

  it("trims and forwards a real projectId", async () => {
    const getWorkspaceSandboxUsage = vi.fn(async (req: { projectId?: string }) => {
      expect(req.projectId).toBe("proj-1");
      return create(GetWorkspaceSandboxUsageResponseSchema, { limits: [] });
    });
    const client = makeClient({ getWorkspaceSandboxUsage });

    await client.getWorkspaceSandboxUsage("ws-001", { projectId: " proj-1 " });
    expect(getWorkspaceSandboxUsage).toHaveBeenCalledTimes(1);
  });

  it("omits a whitespace-only projectId rather than sending an invalid empty string", async () => {
    const getWorkspaceSandboxUsage = vi.fn(async (req: { projectId?: string }) => {
      // Backend validates project_id as a UUID — an empty string would fail
      // server-side, so it must be omitted entirely.
      expect(req.projectId).toBeUndefined();
      return create(GetWorkspaceSandboxUsageResponseSchema, { limits: [] });
    });
    const client = makeClient({ getWorkspaceSandboxUsage });

    await client.getWorkspaceSandboxUsage("ws-001", { projectId: "   " });
    expect(getWorkspaceSandboxUsage).toHaveBeenCalledTimes(1);
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

import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  CIRunnerSizeSchema,
  ListCIRunnerSizesResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("listCIRunnerSizes", () => {
  it("uses the API key's workspace and maps each size", async () => {
    const listCIRunnerSizes = vi.fn(async (req: { workspaceId?: string }) => {
      expect(req.workspaceId).toBeUndefined();
      return create(ListCIRunnerSizesResponseSchema, {
        sizes: [
          create(CIRunnerSizeSchema, { runsOnLabel: "tenki-small-2c-4g", cpu: 2, memory: 4 }),
          create(CIRunnerSizeSchema, { runsOnLabel: "tenki-medium-4c-8g", cpu: 4, memory: 8 }),
        ],
        defaultRunsOnLabel: "tenki-small-2c-4g",
      });
    });
    const client = Object.create(TenkiSandbox.prototype) as TenkiSandbox & { rpcClient: Record<string, unknown> };
    client.rpcClient = { listCIRunnerSizes };

    await expect(client.listCIRunnerSizes()).resolves.toEqual({
      sizes: [
        { runsOnLabel: "tenki-small-2c-4g", cpu: 2, memoryGiB: 4 },
        { runsOnLabel: "tenki-medium-4c-8g", cpu: 4, memoryGiB: 8 },
      ],
      defaultRunsOnLabel: "tenki-small-2c-4g",
    });
    expect(listCIRunnerSizes).toHaveBeenCalledTimes(1);
  });
});

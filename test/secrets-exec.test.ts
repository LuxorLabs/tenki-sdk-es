import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";

import { writeFileStream } from "../src/fs.js";
import {
  RefreshSessionSecretsResponseSchema,
  RunResponseSchema,
  SandboxSessionSchema,
  SessionState,
  type RunRequest,
  type WriteFileStreamRequest,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { Session } from "../src/session.js";

function sessionCapturingRuns(rpcClient: unknown = {}): { session: Session; starts: RunRequest[] } {
  const starts: RunRequest[] = [];
  const run = vi.fn((requests: AsyncIterable<{ frame?: RunRequest }>) => {
    void (async () => {
      for await (const request of requests) {
        if (request.frame?.payload.case === "start") starts.push(request.frame);
      }
    })();
    return (async function* () {
      yield { frame: create(RunResponseSchema, { payload: { case: "started", value: { pid: 7n } } }) };
      yield {
        frame: create(RunResponseSchema, {
          payload: {
            case: "exit",
            value: { exitCode: 0, signal: "", timedOut: false, durationMs: 1n, reason: "exit", errno: 0 },
          },
        }),
      };
    })();
  });
  const proto = create(SandboxSessionSchema, {
    id: "session-1",
    state: SessionState.RUNNING,
    ownerType: "SERVICE",
    ownerId: "self",
  });
  const session = new Session(
    rpcClient as never,
    proto,
    "tk_test",
    "wss://gateway.tenki.test",
    "tenki_session",
    undefined,
    5,
  );
  (session as any).dataPlaneClient = { run };
  return { session, starts };
}

describe("exec withSecrets", () => {
  it("asks the guest for the delivered secrets only when set", async () => {
    const { session, starts } = sessionCapturingRuns();
    await session.exec(["env"], { withSecrets: true });
    await session.exec(["env"]);
    await session.run(["env"], { withSecrets: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const flags = starts.map((frame) => (frame.payload.case === "start" ? frame.payload.value.withSecrets : undefined));
    expect(flags).toEqual([true, false, true]);
  });
});

describe("writeFileStream privileged", () => {
  it("marks the start frame privileged only when asked", async () => {
    const starts: WriteFileStreamRequest[] = [];
    const dataPlane = {
      writeFileStream: vi.fn(async (frames: AsyncIterable<{ frame?: WriteFileStreamRequest }>) => {
        for await (const request of frames) {
          if (request.frame?.payload.case === "start") starts.push(request.frame);
        }
        return {};
      }),
    };
    const session = { id: "session-1", requireDataPlane: async () => dataPlane } as unknown as Session;
    const body = () => new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array([1])), c.close()) });
    await writeFileStream(session, "/etc/app.conf", body(), { privileged: true });
    await writeFileStream(session, "notes.txt", body());
    const privileged = starts.map((frame) =>
      frame.payload.case === "start" ? frame.payload.value.privileged : undefined,
    );
    expect(privileged).toEqual([true, false]);
  });
});

describe("refreshSecrets", () => {
  it("returns secret names and versions from the engine", async () => {
    const refreshSessionSecrets = vi.fn(async () =>
      create(RefreshSessionSecretsResponseSchema, {
        changed: true,
        workflowId: "sandbox-runtime-secret-refresh-session-1",
        versions: [{ secretName: "TOKEN", version: 2, environmentKey: "API_TOKEN", filePath: "" }],
      }),
    );
    const { session } = sessionCapturingRuns({ refreshSessionSecrets });
    const refresh = await session.refreshSecrets();
    expect(refreshSessionSecrets).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1" }));
    expect(refresh).toEqual({
      changed: true,
      workflowId: "sandbox-runtime-secret-refresh-session-1",
      versions: [{ secretName: "TOKEN", version: 2, environmentKey: "API_TOKEN", filePath: "" }],
    });
  });
});

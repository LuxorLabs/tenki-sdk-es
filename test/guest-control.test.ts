import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { SandboxService, SessionState } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("guest control capability", () => {
  it.each([undefined, false, true])("maps capability %s and refreshes it", async (guestControlDenied) => {
    let denied = guestControlDenied;
    const client = new TenkiSandbox({
      authToken: "tk_SYNTHETIC_CANARY_NOT_A_CREDENTIAL",
      transport: createRouterTransport((router) =>
        router.service(SandboxService, {
          getSession: () => ({ session: { id: "session", state: SessionState.RUNNING, guestControlDenied: denied } }),
        }),
      ),
    });
    const session = await client.get("session");
    expect(session.guestControlDenied).toBe(guestControlDenied ?? false);
    expect(session.toJSON().guestControlDenied).toBe(guestControlDenied ?? false);
    denied = !guestControlDenied;
    await session.refresh();
    expect(session.guestControlDenied).toBe(denied);
  });
});

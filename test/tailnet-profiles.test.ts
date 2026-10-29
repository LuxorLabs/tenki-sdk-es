import { describe, expect, it } from "vitest";

import { tailnetAttachmentToProto, TailnetAuthKey } from "../src/tailnet.js";

describe("saved Tailscale connections", () => {
  it("preserves a pinned profile reference without an enrollment key", () => {
    const profileId = "11111111-1111-4111-8111-111111111111";
    const request = tailnetAttachmentToProto({ profileId, profileRevision: 3 });
    expect(request.credential).toEqual({ case: "profileId", value: profileId });
    expect(request.profileRevision).toBe(3);
  });
  it("rejects mixed credentials", () => {
    expect(() => tailnetAttachmentToProto({ profileId: "profile", authKey: new TailnetAuthKey("sentinel") })).toThrow(
      "one tailnet credential",
    );
  });
});

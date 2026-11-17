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

describe("typed tailnet exposure", () => {
  it("keeps UDP separate from legacy TCP", () => {
    const request = tailnetAttachmentToProto({
      authKey: new TailnetAuthKey("sentinel"),
      exposePorts: [3000],
      exposedPorts: [
        { port: 6081, protocol: "udp" },
        { port: 6081, protocol: "tcp" },
      ],
    });
    expect(request.exposePorts).toEqual([3000]);
    expect(request.exposedPorts.map(({ port, protocol }) => ({ port, protocol }))).toEqual([
      { port: 6081, protocol: 2 },
      { port: 6081, protocol: 1 },
    ]);
  });
  it.each([0, 65536, 1.5, NaN])("rejects invalid port %s", (port) => {
    expect(() =>
      tailnetAttachmentToProto({ authKey: new TailnetAuthKey("sentinel"), exposedPorts: [{ port, protocol: "udp" }] }),
    ).toThrow("invalid tailnet exposed port");
  });
});

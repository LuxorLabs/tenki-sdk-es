import { describe, expect, it } from "vitest";

import { egressPolicySpecToProto, publicEgressAcknowledged } from "../src/egress-policies.js";
import { egressPolicyFromProto } from "../src/session.js";

describe("public egress restrictions", () => {
  it("preserves absence separately from deny-all", () => {
    expect(egressPolicySpecToProto({}).publicEgress).toBeUndefined();
    const denied = egressPolicySpecToProto({ publicEgress: {} });
    expect(denied.publicEgress?.tcpPorts).toEqual([]);
    expect(egressPolicyFromProto(denied).publicEgress).toEqual({ tcpPorts: [], udpPorts: [] });
  });
  it("rejects missing or wider server acknowledgements", () => {
    const requested = { tcpPorts: [80, 443], udpPorts: [] };
    expect(publicEgressAcknowledged(requested, undefined)).toBe(false);
    expect(publicEgressAcknowledged(requested, { tcpPorts: [22], udpPorts: [] })).toBe(false);
    expect(publicEgressAcknowledged(requested, { tcpPorts: [443], udpPorts: [] })).toBe(true);
    expect(publicEgressAcknowledged(undefined, undefined)).toBe(true);
  });
});

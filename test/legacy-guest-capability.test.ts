import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { CapabilityUnavailableError, mapError } from "../src/errors.js";

// Node-agent wire text for Stat on a guest agent that predates the fs primitives; the Go and Python SDK tests use the same string.
const legacyGuestStatWireText = "guest_error: unknown request type: *sandboxv1.GuestRequest_Stat";

describe("legacy guest without a primitive", () => {
  it.each([Code.Unimplemented, Code.Internal])("maps code %s to CapabilityUnavailableError", (code) => {
    const mapped = mapError(new ConnectError(legacyGuestStatWireText, code));

    expect(mapped).toBeInstanceOf(CapabilityUnavailableError);
    expect((mapped as CapabilityUnavailableError).primitive).toBe("Stat");
    expect(mapped.cause).toBeInstanceOf(ConnectError);
  });

  it("keeps a guest I/O error out of CapabilityUnavailableError", () => {
    const mapped = mapError(new ConnectError("guest_error: read /home/tenki/f: input/output error", Code.Internal));

    expect(mapped).not.toBeInstanceOf(CapabilityUnavailableError);
  });
});

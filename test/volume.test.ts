import { describe, expect, it } from "vitest";

import { VolumeState as ProtoVolumeState } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { volumeIsReady, volumeStateFromProto } from "../src/volume.js";

describe("volume state", () => {
  it("maps IN_USE without treating it as ready", () => {
    expect(volumeStateFromProto(ProtoVolumeState.IN_USE)).toBe("IN_USE");
    expect(volumeIsReady("IN_USE")).toBe(false);
  });
});

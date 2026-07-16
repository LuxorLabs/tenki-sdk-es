import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  TemplateBuildEventSchema,
  TemplateBuildProgressEventSchema,
  TemplateBuildProvenanceSchema,
  TemplateBuildSchema,
} from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";
import { templateBuildFromProto } from "../src/template.js";

describe("template build conversion", () => {
  it("preserves unspecified progress state and ignores unknown events", () => {
    const build = templateBuildFromProto(
      create(TemplateBuildSchema, {
        events: [
          create(TemplateBuildEventSchema),
          create(TemplateBuildEventSchema, {
            event: {
              case: "progress",
              value: create(TemplateBuildProgressEventSchema),
            },
          }),
        ],
      }),
    );

    expect(build?.events).toEqual([expect.objectContaining({ type: "progress", state: "unspecified" })]);
  });

  it("preserves build secret key provenance", () => {
    const proto = create(TemplateBuildSchema, {
      provenance: create(TemplateBuildProvenanceSchema, {
        buildSecretKeys: ["GIT_TOKEN", "NPM_TOKEN"],
      }),
    });
    const build = templateBuildFromProto(proto);
    proto.provenance?.buildSecretKeys.splice(0, 1, "mutated");

    expect(build?.provenance?.buildSecretKeys).toEqual(["GIT_TOKEN", "NPM_TOKEN"]);
  });
});

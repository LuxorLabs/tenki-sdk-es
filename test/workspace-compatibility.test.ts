import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { ListProjectSandboxesRequestSchema } from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

describe("workspace compatibility contract", () => {
  it("decodes legacy Project request bytes after workspace field expansion", () => {
    const projectId = "019f69c7-96c9-7971-83d8-896b9d035b36";
    const encodedProjectId = new TextEncoder().encode(projectId);
    const wire = new Uint8Array([0x0a, encodedProjectId.length, ...encodedProjectId]);

    const request = fromBinary(ListProjectSandboxesRequestSchema, wire);

    expect(request.projectId).toBe(projectId);
    expect(request.workspaceId).toBeUndefined();
  });
});

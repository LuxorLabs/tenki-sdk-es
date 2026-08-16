import { describe, expect, it } from "vitest";

import {
  CreatePreviewUrlRequestSchema,
  CreateSessionRequestSchema,
  CreateVolumeRequestSchema,
  GetWorkspaceSandboxUsageRequestSchema,
  ListPreviewUrlsRequestSchema,
  PreviewUrlSchema,
  SandboxSessionSchema,
  SnapshotSchema,
  VolumeSchema,
  WhoAmIWorkspaceSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { CreateTemplateRequestSchema, TemplateSchema } from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";

const removedFieldReservations = [
  { schema: VolumeSchema, tag: 8, name: "project_id" },
  { schema: SandboxSessionSchema, tag: 19, name: "project_id" },
  { schema: SnapshotSchema, tag: 12, name: "project_id" },
  { schema: PreviewUrlSchema, tag: 2, name: "project_id" },
  { schema: CreateSessionRequestSchema, tag: 20, name: "project_id" },
  { schema: CreateVolumeRequestSchema, tag: 4, name: "project_id" },
  { schema: CreatePreviewUrlRequestSchema, tag: 1, name: "project_id" },
  { schema: ListPreviewUrlsRequestSchema, tag: 1, name: "project_id" },
  { schema: GetWorkspaceSandboxUsageRequestSchema, tag: 2, name: "project_id" },
  { schema: WhoAmIWorkspaceSchema, tag: 3, name: "projects" },
  { schema: TemplateSchema, tag: 14, name: "project_id" },
  { schema: CreateTemplateRequestSchema, tag: 8, name: "project_id" },
];

describe("generated v1 descriptor compatibility", () => {
  it("keeps removed field tags and names reserved", () => {
    for (const { schema, tag, name } of removedFieldReservations) {
      expect(
        schema.fields.some((field) => field.number === tag),
        `${schema.typeName} reuses tag ${tag}`,
      ).toBe(false);
      expect(
        schema.proto.reservedRange.some((range) => range.start <= tag && tag < range.end),
        `${schema.typeName} does not reserve tag ${tag}`,
      ).toBe(true);
      expect(schema.proto.reservedName, `${schema.typeName} does not reserve ${name}`).toContain(name);
    }
  });
});

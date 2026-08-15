import type { DescFile } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import * as codeReviewV1 from "../src/internal/proto/tenki/sandbox/v1/codereview_pb.js";
import * as guestAgentV1 from "../src/internal/proto/tenki/sandbox/v1/guest_agent_pb.js";
import * as nodeAgentV1 from "../src/internal/proto/tenki/sandbox/v1/node_agent_pb.js";
import { ProvisionSessionCommandSchema } from "../src/internal/proto/tenki/sandbox/v1/node_agent_pb.js";
import * as registryV1 from "../src/internal/proto/tenki/sandbox/v1/registry_pb.js";
import * as sandboxAdminV1 from "../src/internal/proto/tenki/sandbox/v1/sandbox_admin_pb.js";
import * as sandboxOpsV1 from "../src/internal/proto/tenki/sandbox/v1/sandbox_ops_pb.js";
import * as sandboxV1 from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
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
import * as sshGatewayClientV1 from "../src/internal/proto/tenki/sandbox/v1/ssh_gateway_client_pb.js";
import * as templateV1 from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";
import { CreateTemplateRequestSchema, TemplateSchema } from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";
import * as tunnelV1 from "../src/internal/proto/tenki/sandbox/v1/tunnel_pb.js";

const generatedV1Modules = [
  codeReviewV1,
  guestAgentV1,
  nodeAgentV1,
  registryV1,
  sandboxAdminV1,
  sandboxOpsV1,
  sandboxV1,
  sshGatewayClientV1,
  templateV1,
  tunnelV1,
];

const generatedV1Files = generatedV1Modules.flatMap((module) => Object.values(module).filter(isFileDescriptor));

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
  { schema: ProvisionSessionCommandSchema, tag: 18, name: "project_id" },
];

describe("generated v1 contract", () => {
  it("exposes no Tenki Project symbols", () => {
    const messages = generatedV1Files.flatMap((file) => file.messages);
    for (let index = 0; index < messages.length; index++) {
      messages.push(...messages[index]!.nestedMessages);
    }

    const enums = generatedV1Files.flatMap((file) => file.enums);
    for (const message of messages) {
      enums.push(...message.nestedEnums);
    }

    const symbols = [
      ...generatedV1Modules.flatMap((module) => Object.keys(module)),
      ...messages.flatMap((message) => [
        message.name,
        message.typeName,
        ...message.fields.flatMap((field) => [field.name, field.localName, field.jsonName]),
      ]),
      ...enums.flatMap((enumType) => [
        enumType.name,
        enumType.typeName,
        ...enumType.values.flatMap((value) => [value.name, value.localName]),
      ]),
      ...generatedV1Files.flatMap((file) =>
        file.services.flatMap((service) => [
          service.name,
          service.typeName,
          ...service.methods.flatMap((method) => [method.name, method.localName]),
        ]),
      ),
    ];

    expect(symbols.filter((symbol) => symbol.toLowerCase().includes("project"))).toEqual([]);
  });

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

function isFileDescriptor(value: unknown): value is DescFile {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "file";
}

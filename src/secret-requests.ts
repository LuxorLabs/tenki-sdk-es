import { create } from "@bufbuild/protobuf";

import { SecretRequestBindingSchema } from "./internal/proto/tenki/sandbox/v1/secret_injection_pb.js";

export interface SecretRequestBinding {
  name: string;
  secretName: string;
  origin: string;
  methods: string[];
  pathPrefix: string;
  header?: string;
  queryParameter?: string;
  jsonPointer?: string;
}

export function secretRequestToProto(rule: SecretRequestBinding) {
  return create(SecretRequestBindingSchema, { ...rule, methods: [...rule.methods] });
}

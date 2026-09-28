import { create } from "@bufbuild/protobuf";

import { SecretHeaderBindingSchema } from "./internal/proto/tenki/sandbox/v1/secret_injection_pb.js";

export interface SecretHeaderBinding {
  name: string;
  secretName: string;
  origin: string;
  methods: string[];
  pathPrefix: string;
  header: string;
}

export function secretHeaderToProto(rule: SecretHeaderBinding) {
  return create(SecretHeaderBindingSchema, { ...rule, methods: [...rule.methods] });
}

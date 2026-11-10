import { create, fromBinary, isFieldSet, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  StorageAccess,
  StorageAuthMethod,
  StorageMountSchema,
  StorageMountSpecSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  storageAuthMethodToProto,
  storageCredentialsToProto,
  storageMountFromProto,
  storageMountSpecToProto,
} from "../src/storage.js";

describe("storage mount wire contract", () => {
  it("names a connection by id before name and leaves access unset for the connection default", () => {
    const byId = storageMountSpecToProto({ connectionId: " c1 ", connectionName: "datasets", mountPath: "/mnt/data" });
    expect(byId.connection).toEqual({ case: "connectionId", value: "c1" });
    expect(isFieldSet(byId, StorageMountSpecSchema.field.access)).toBe(false);
    expect(isFieldSet(byId, StorageMountSpecSchema.field.prefix)).toBe(false);

    const byName = storageMountSpecToProto({ connectionName: "datasets", mountPath: "/mnt/data", access: "READ_ONLY" });
    expect(byName.connection).toEqual({ case: "connectionName", value: "datasets" });
    expect(byName.access).toBe(StorageAccess.READ_ONLY);

    const override = storageMountSpecToProto({ defaultMountId: "d1", mountPath: "/workspace/data" });
    expect(override.connection.case).toBeUndefined();
    expect(override.defaultMountId).toBe("d1");
  });

  it("sends an empty prefix and connection-default access so an override can clear a default's values", () => {
    const spec = storageMountSpecToProto({ defaultMountId: "d1", prefix: "", access: "" });
    const wire = fromBinary(StorageMountSpecSchema, toBinary(StorageMountSpecSchema, spec));
    expect(isFieldSet(wire, StorageMountSpecSchema.field.prefix)).toBe(true);
    expect(wire.prefix).toBe("");
    expect(isFieldSet(wire, StorageMountSpecSchema.field.access)).toBe(true);
    expect(wire.access).toBe(StorageAccess.UNSPECIFIED);

    const kept = fromBinary(
      StorageMountSpecSchema,
      toBinary(StorageMountSpecSchema, storageMountSpecToProto({ defaultMountId: "d1", mountPath: "/x" })),
    );
    expect(isFieldSet(kept, StorageMountSpecSchema.field.prefix)).toBe(false);
    expect(isFieldSet(kept, StorageMountSpecSchema.field.access)).toBe(false);
  });

  it("reports a mount's resolved prefix and access", () => {
    const mount = storageMountFromProto(
      create(StorageMountSchema, {
        id: "m1",
        spec: { prefix: "", mountPath: "/mnt/data", access: StorageAccess.READ_WRITE },
      }),
    );
    expect(mount.spec.prefix).toBe("");
    expect(mount.spec.access).toBe("READ_WRITE");
  });

  it("sends each credential as a secret name or a value, never both", () => {
    const credentials = storageCredentialsToProto({
      accessKeyId: { secretName: "R2_KEY_ID" },
      secretAccessKey: { value: "secret-value" },
    });
    expect(credentials?.accessKeyId?.source).toEqual({ case: "secretName", value: "R2_KEY_ID" });
    expect(credentials?.secretAccessKey?.source).toEqual({ case: "value", value: "secret-value" });
    expect(credentials?.sessionToken).toBeUndefined();
  });

  it("refuses a secret with both or neither of secretName and value, like the Python SDK", () => {
    const both = { secretName: "R2_KEY_ID", value: "AKIA" } as unknown as { value: string };
    expect(() => storageCredentialsToProto({ accessKeyId: both })).toThrow(TypeError);
    expect(() => storageCredentialsToProto({ accessKeyId: {} as { value: string } })).toThrow(TypeError);
    expect(() => storageCredentialsToProto({ accessKeyId: { secretName: "  " } })).toThrow(TypeError);
    expect(() => storageCredentialsToProto({ accessKeyId: { value: "" } })).toThrow(TypeError);
  });

  it("maps auth methods by name", () => {
    expect(storageAuthMethodToProto("AWS_OIDC_ROLE")).toBe(StorageAuthMethod.AWS_OIDC_ROLE);
    expect(storageAuthMethodToProto("R2_TEMPORARY")).toBe(StorageAuthMethod.R2_TEMPORARY);
  });
});

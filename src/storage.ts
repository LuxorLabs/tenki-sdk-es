import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";

import {
  StorageAccess as ProtoStorageAccess,
  StorageAuthMethod as ProtoStorageAuthMethod,
  StorageProvider as ProtoStorageProvider,
  StorageTestReason as ProtoStorageTestReason,
  StorageConnectionCredentialsSchema,
  StorageDefaultMountSchema,
  StorageMountSpecSchema,
  StorageSecretValueSchema,
  type StorageConnection as ProtoStorageConnection,
  type StorageDefaults as ProtoStorageDefaults,
  type StorageMount as ProtoStorageMount,
  type StorageMountSpec as ProtoStorageMountSpec,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export type StorageProvider = "UNSPECIFIED" | "AWS_S3" | "GCS" | "R2" | "S3_COMPATIBLE";
/**
 * ACCESS_KEY reads a key pair (GCS: HMAC keys) from Tenki Secrets; AWS_OIDC_ROLE assumes an IAM role that
 * trusts Tenki's OIDC issuer; R2_TEMPORARY mints scoped short-lived R2 keys from a Cloudflare API token.
 */
export type StorageAuthMethod = "UNSPECIFIED" | "ACCESS_KEY" | "AWS_OIDC_ROLE" | "R2_TEMPORARY";
/** Omit on a new mount to use the connection's default access. */
export type StorageAccess = "READ_ONLY" | "READ_WRITE";

/** An existing s3_storage Tenki Secret by name, or a value Tenki stores as a new secret. */
export type StorageSecret = { secretName: string } | { value: string };

/** Omit a field on update to keep its current secret. */
export interface StorageConnectionCredentials {
  accessKeyId?: StorageSecret;
  secretAccessKey?: StorageSecret;
  sessionToken?: StorageSecret;
  r2ParentToken?: StorageSecret;
  roleArn?: string;
}

/** Names of the Tenki Secrets a connection reads. */
export interface StorageConnectionSecrets {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  r2ParentToken: string;
}

export interface StorageConnection {
  id: string;
  workspaceId: string;
  name: string;
  provider: StorageProvider;
  endpoint: string;
  bucket: string;
  region: string;
  authMethod: StorageAuthMethod;
  roleArn: string;
  secrets: StorageConnectionSecrets;
  defaultAccess?: StorageAccess;
  revision: bigint;
  /** Subject an AWS role trust policy must match for keyless access. */
  oidcSubjectPattern: string;
  activeMountCount: number;
  defaultMountCount: number;
  lastTestedAt?: Date;
  lastTestReason?: string;
  /** Tenki disabled the connection: it accepts no new mounts and issues no credentials. */
  disabled: boolean;
  disabledAt?: Date;
}

export interface StorageConnectionList {
  connections: StorageConnection[];
  /** URL to register as an AWS IAM OIDC identity provider; empty when keyless AWS is unavailable. */
  oidcIssuer: string;
  oidcAudience: string;
}

export interface StorageConnectionTest {
  reachable: boolean;
  reason?: string;
  message: string;
}

/**
 * Name the connection by connectionId or connectionName; set defaultMountId to change a workspace default.
 * An omitted prefix or access keeps the default mount's value. An empty prefix mounts the whole bucket,
 * and access "" uses the connection's default access.
 */
export interface StorageMountConfig {
  connectionId?: string;
  connectionName?: string;
  prefix?: string;
  mountPath?: string;
  access?: StorageAccess | "";
  defaultMountId?: string;
}

export interface StorageMount {
  id: string;
  sessionId: string;
  connectionName: string;
  spec: StorageMountConfig;
  state: string;
  lastError: string;
}

export interface StorageDefaultMount {
  id?: string;
  connectionId: string;
  prefix?: string;
  mountPath: string;
  access?: StorageAccess;
}

export interface StorageDefaults {
  workspaceId: string;
  mounts: StorageDefaultMount[];
  revision: number;
}

function enumName(names: Record<number, string>, value: number): string | undefined {
  const name = names[value];
  return name === undefined || name === "UNSPECIFIED" ? undefined : name;
}

export function storageAccessToProto(access?: StorageAccess | ""): ProtoStorageAccess {
  return access ? ProtoStorageAccess[access] : ProtoStorageAccess.UNSPECIFIED;
}

function storageAccessFromProto(access: ProtoStorageAccess): StorageAccess | undefined {
  return enumName(ProtoStorageAccess, access) as StorageAccess | undefined;
}

export function storageProviderToProto(provider: StorageProvider): ProtoStorageProvider {
  return ProtoStorageProvider[provider] ?? ProtoStorageProvider.UNSPECIFIED;
}

export function storageAuthMethodToProto(method: StorageAuthMethod): ProtoStorageAuthMethod {
  return ProtoStorageAuthMethod[method] ?? ProtoStorageAuthMethod.UNSPECIFIED;
}

export function storageTestReasonFromProto(reason: ProtoStorageTestReason): string | undefined {
  return enumName(ProtoStorageTestReason, reason);
}

function storageSecretToProto(secret?: StorageSecret) {
  if (!secret) return undefined;
  const fields = secret as { secretName?: string; value?: string };
  const name = fields.secretName?.trim() ?? "";
  const value = fields.value ?? "";
  if ((name === "") === (value === "")) {
    throw new TypeError("a storage secret needs exactly one of secretName or value");
  }
  if (name !== "") return create(StorageSecretValueSchema, { source: { case: "secretName", value: name } });
  return create(StorageSecretValueSchema, { source: { case: "value", value } });
}

export function storageCredentialsToProto(credentials?: StorageConnectionCredentials) {
  if (!credentials) return undefined;
  return create(StorageConnectionCredentialsSchema, {
    accessKeyId: storageSecretToProto(credentials.accessKeyId),
    secretAccessKey: storageSecretToProto(credentials.secretAccessKey),
    sessionToken: storageSecretToProto(credentials.sessionToken),
    r2ParentToken: storageSecretToProto(credentials.r2ParentToken),
    roleArn: credentials.roleArn?.trim() ?? "",
  });
}

export function storageMountSpecToProto(mount: StorageMountConfig) {
  const connectionId = mount.connectionId?.trim();
  const connectionName = mount.connectionName?.trim();
  return create(StorageMountSpecSchema, {
    connection: connectionId
      ? { case: "connectionId", value: connectionId }
      : connectionName
        ? { case: "connectionName", value: connectionName }
        : { case: undefined },
    prefix: mount.prefix?.trim(),
    mountPath: mount.mountPath?.trim() ?? "",
    access: mount.access === undefined ? undefined : storageAccessToProto(mount.access),
    defaultMountId: mount.defaultMountId?.trim() ?? "",
  });
}

export function storageDefaultMountToProto(mount: StorageDefaultMount) {
  return create(StorageDefaultMountSchema, {
    id: mount.id ?? "",
    connectionId: mount.connectionId.trim(),
    prefix: mount.prefix?.trim() ?? "",
    mountPath: mount.mountPath.trim(),
    access: storageAccessToProto(mount.access),
  });
}

export function storageConnectionFromProto(connection: ProtoStorageConnection): StorageConnection {
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    name: connection.name,
    provider: (enumName(ProtoStorageProvider, connection.provider) ?? "UNSPECIFIED") as StorageProvider,
    endpoint: connection.endpoint,
    bucket: connection.bucket,
    region: connection.region,
    authMethod: (enumName(ProtoStorageAuthMethod, connection.authMethod) ?? "UNSPECIFIED") as StorageAuthMethod,
    roleArn: connection.roleArn,
    secrets: {
      accessKeyId: connection.secrets?.accessKeyId ?? "",
      secretAccessKey: connection.secrets?.secretAccessKey ?? "",
      sessionToken: connection.secrets?.sessionToken ?? "",
      r2ParentToken: connection.secrets?.r2ParentToken ?? "",
    },
    defaultAccess: storageAccessFromProto(connection.defaultAccess),
    revision: connection.revision,
    oidcSubjectPattern: connection.oidcSubjectPattern,
    activeMountCount: connection.activeMountCount,
    defaultMountCount: connection.defaultMountCount,
    lastTestedAt: connection.lastTestedAt ? timestampDate(connection.lastTestedAt) : undefined,
    lastTestReason: storageTestReasonFromProto(connection.lastTestReason),
    disabled: connection.disabled,
    disabledAt: connection.disabledAt ? timestampDate(connection.disabledAt) : undefined,
  };
}

export function storageDefaultsFromProto(defaults?: ProtoStorageDefaults): StorageDefaults {
  return {
    workspaceId: defaults?.workspaceId ?? "",
    revision: defaults?.revision ?? 0,
    mounts: (defaults?.mounts ?? []).map((mount) => ({
      id: mount.id,
      connectionId: mount.connectionId,
      prefix: mount.prefix,
      mountPath: mount.mountPath,
      access: storageAccessFromProto(mount.access),
    })),
  };
}

function storageMountSpecFromProto(spec?: ProtoStorageMountSpec): StorageMountConfig {
  return {
    connectionId: spec?.connection.case === "connectionId" ? spec.connection.value : undefined,
    connectionName: spec?.connection.case === "connectionName" ? spec.connection.value : undefined,
    prefix: spec?.prefix,
    mountPath: spec?.mountPath ?? "",
    access: spec?.access === undefined ? undefined : (storageAccessFromProto(spec.access) ?? ""),
    defaultMountId: spec?.defaultMountId || undefined,
  };
}

export function storageMountFromProto(mount: ProtoStorageMount): StorageMount {
  return {
    id: mount.id,
    sessionId: mount.sessionId,
    connectionName: mount.connectionName,
    spec: storageMountSpecFromProto(mount.spec),
    state: mount.state,
    lastError: mount.lastError,
  };
}

import { fromJson, type JsonValue } from "@bufbuild/protobuf";

import {
  RuntimeSecretFileSchema,
  type RuntimeSecretFile as ProtoFile,
} from "./internal/proto/tenki/sandbox/v1/secret_file_pb.js";

export interface RuntimeSecretReference {
  name: string;
  placeholder?: boolean;
}
export type RuntimeSecretFile = { path: string } & (
  | { raw: RuntimeSecretReference }
  | { source: string }
  | { content: string }
);

export function secretFileToProto(file: RuntimeSecretFile): ProtoFile {
  return fromJson(RuntimeSecretFileSchema, file as unknown as JsonValue);
}

export function validSecretFiles(files: ProtoFile[], count: number): boolean {
  if (files.length > 32) return false;
  for (const [index, file] of files.entries()) {
    if (
      new TextEncoder().encode(file.path).length > 4096 ||
      /[\x00-\x1f]/.test(file.path) ||
      !/^\/(home\/tenki|workspace|app)\/.+/.test(file.path) ||
      file.path
        .split("/")
        .slice(1)
        .some((p) => !p || p === "." || p === "..")
    )
      return false;
    if (files.some((other, j) => j !== index && (file.path === other.path || file.path.startsWith(other.path + "/"))))
      return false;
    const refs: RuntimeSecretReference[] = [];
    switch (file.format.case) {
      case "source":
        if (
          !/^\/(home\/tenki|workspace|app)\/.+/.test(file.format.value) ||
          file.format.value
            .split("/")
            .slice(1)
            .some((p) => !p || p === "." || p === "..") ||
          /[\x00-\x1f]/.test(file.format.value) ||
          new TextEncoder().encode(file.format.value).length > 4096
        )
          return false;
        break;
      case "content": {
        const names = secretFileNames(file.format.value);
        if (names === null) return false;
        refs.push(...names.map((name) => ({ name })));
        break;
      }
      case "raw":
        refs.push(file.format.value);
        break;
      default:
        return false;
    }
    count += refs.length;
    if (refs.some((ref) => !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(ref.name))) return false;
  }
  return count <= 64;
}

/** Names in single-pass file markers; null means malformed or oversized text. */
export function secretFileNames(content: string): string[] | null {
  if (new TextEncoder().encode(content).length > 262144 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return null;
  const names = new Set<string>();
  let offset = 0;
  while (true) {
    const index = content.indexOf("secrets://", offset);
    if (index < 0) break;
    offset = index + "secrets://".length;
    if (index > 0 && content[index - 1] === "\\") continue;
    const name = content.slice(offset).match(/^[A-Za-z0-9_-]*/)?.[0] ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name)) return null;
    names.add(name);
    if (names.size > 64) return null;
    offset += name.length;
  }
  return [...names];
}

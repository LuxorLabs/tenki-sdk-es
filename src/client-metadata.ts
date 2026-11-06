declare const __TENKI_SDK_VERSION__: string;

const CLIENT_GENERATION = "1";

function runtime(): string {
  const deno = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno?.version?.deno;
  if (deno) return `deno/${deno}`;
  if (typeof process === "undefined") return "unknown/unknown";
  if (process.versions?.bun) return `bun/${process.versions.bun}`;
  return `node/${process.versions?.node ?? "unknown"}`;
}

const clientMetadata: ReadonlyArray<readonly [string, string]> = [
  ["x-tenki-client-family", "typescript"],
  ["x-tenki-client-version", __TENKI_SDK_VERSION__],
  ["x-tenki-client-generation", CLIENT_GENERATION],
  ["x-tenki-client-runtime", runtime()],
];

export function setClientMetadataHeaders(headers: Headers): void {
  for (const [name, value] of clientMetadata) headers.set(name, value);
}

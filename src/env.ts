/** Returns the first non-blank environment value among names, trimmed, in order. */
export function readEnv(names: readonly string[]): string {
  if (typeof process === "undefined") return "";
  for (const name of names) {
    const value = process.env?.[name]?.trim();
    if (value) return value;
  }
  return "";
}

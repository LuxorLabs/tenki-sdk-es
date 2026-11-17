import { API_KEY_PREFIXES, ENV_LUXOR_API_KEY } from "./constants.js";

/** Returns the first usable environment value among names, trimmed, in order. */
export function readEnv(names: readonly string[]): string {
  if (typeof process === "undefined") return "";
  for (const name of names) {
    const value = process.env?.[name]?.trim();
    if (!value) continue;
    // LUXOR_API_KEY may hold a non-sandbox key, so it only counts with a known prefix.
    if (name === ENV_LUXOR_API_KEY && !API_KEY_PREFIXES.some((prefix) => value.startsWith(prefix))) continue;
    return value;
  }
  return "";
}

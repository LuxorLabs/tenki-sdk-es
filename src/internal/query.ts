export function queryKeyHashFn(queryKey: unknown): string {
  return JSON.stringify(queryKey, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

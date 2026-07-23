import { PaginationStalledError } from "./errors.js";

const AUTOMATIC_PAGE_SIZE = 100;

export function automaticPageSize(): number {
  return AUTOMATIC_PAGE_SIZE;
}

export function advancePageToken(current: string, next: string | undefined): string {
  const normalized = (next ?? "").trim();
  if (normalized && normalized === current) {
    throw new PaginationStalledError("sandbox: pagination token did not advance");
  }
  return normalized;
}

import type { Interceptor } from "@connectrpc/connect";

import { InvalidAuthTokenError, MissingAuthTokenError } from "./errors.js";

export function validateAuthToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new MissingAuthTokenError();
  if (!trimmed.startsWith("tk_")) throw new InvalidAuthTokenError();
  return trimmed;
}

export function createAuthInterceptor(token: string): Interceptor {
  const authToken = validateAuthToken(token);
  return (next) => async (req) => {
    setAuthHeaders(req.header, authToken);
    return next(req);
  };
}

export function setAuthHeaders(headers: Headers, token: string): void {
  const authToken = validateAuthToken(token);
  headers.set("Authorization", `Bearer ${authToken}`);
}

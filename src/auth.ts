import type { Interceptor } from "@connectrpc/connect";

import { ENV_API_KEY, ENV_AUTH_TOKEN } from "./constants.js";
import { InvalidAuthTokenError, MissingAuthTokenError } from "./errors.js";

export function validateAuthToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new MissingAuthTokenError();
  if (!trimmed.startsWith("tk_")) throw new InvalidAuthTokenError();
  return trimmed;
}

/** apiKey is an alias for authToken; an explicit authToken wins, then the environment. */
export function resolveAuthToken(authToken?: string, apiKey?: string): string {
  const explicit = authToken?.trim() || "";
  const alias = apiKey?.trim() || "";
  return validateAuthToken(explicit || alias || envToken());
}

function envToken(): string {
  if (typeof process === "undefined") return "";
  return process.env?.[ENV_AUTH_TOKEN] || process.env?.[ENV_API_KEY] || "";
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

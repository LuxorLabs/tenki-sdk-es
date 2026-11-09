import type { Interceptor } from "@connectrpc/connect";

import { setClientMetadataHeaders } from "./client-metadata.js";
import { API_KEY_PREFIXES, AUTH_TOKEN_ENVS, SDK_HEADER, SDK_HEADER_VALUE, SDK_USER_AGENT } from "./constants.js";
import { readEnv } from "./env.js";
import { InvalidAuthTokenError, MissingAuthTokenError } from "./errors.js";

export function validateAuthToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) throw new MissingAuthTokenError();
  if (!API_KEY_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) throw new InvalidAuthTokenError();
  return trimmed;
}

/** apiKey is an alias for authToken; an explicit authToken wins, then the environment. */
export function resolveAuthToken(authToken?: string, apiKey?: string): string {
  const explicit = authToken?.trim() || "";
  const alias = apiKey?.trim() || "";
  return validateAuthToken(explicit || alias || readEnv(AUTH_TOKEN_ENVS));
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
  setSdkIdentityHeaders(headers);
  setClientMetadataHeaders(headers);
}

/** Sets the SDK header and leads the User-Agent with the SDK product, keeping any existing value. */
export function setSdkIdentityHeaders(headers: Headers): void {
  headers.set(SDK_HEADER, SDK_HEADER_VALUE);
  const existing = headers.get("User-Agent");
  if (!existing) headers.set("User-Agent", SDK_USER_AGENT);
  else if (!existing.startsWith(SDK_USER_AGENT)) headers.set("User-Agent", `${SDK_USER_AGENT} ${existing}`);
}

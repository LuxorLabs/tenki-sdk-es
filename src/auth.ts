import type { Interceptor } from "@connectrpc/connect";

export function createAuthInterceptor(token: string, cookieName: string): Interceptor {
  return (next) => async (req) => {
    setAuthHeaders(req.header, token, cookieName);
    return next(req);
  };
}

export function setAuthHeaders(headers: Headers, token: string, cookieName: string): void {
  const trimmed = token.trim();
  if (!trimmed) return;

  if (trimmed.startsWith("tk_")) {
    headers.set("Authorization", `Bearer ${trimmed}`);
  } else if (trimmed.startsWith("ory_st_")) {
    headers.set("X-Session-Token", trimmed);
  } else {
    headers.set("Cookie", `${cookieName}=${trimmed}`);
  }
}

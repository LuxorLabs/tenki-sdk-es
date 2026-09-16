import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAuthToken, setAuthHeaders } from "../src/auth.js";
import { InvalidAuthTokenError, MissingAuthTokenError } from "../src/errors.js";

describe("setAuthHeaders", () => {
  it("sets Bearer for tk_ tokens", () => {
    const headers = new Headers();
    setAuthHeaders(headers, "tk_abc123");
    expect(headers.get("Authorization")).toBe("Bearer tk_abc123");
    expect(headers.get("X-Session-Token")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
  });

  it.each(["ory_st_xyz", "arbitrary-value"])("rejects invalid credential %s", (token) => {
    expect(() => setAuthHeaders(new Headers(), token)).toThrow(InvalidAuthTokenError);
  });

  it("rejects an empty token", () => {
    expect(() => setAuthHeaders(new Headers(), "  ")).toThrow(MissingAuthTokenError);
  });

  it("trims whitespace", () => {
    const headers = new Headers();
    setAuthHeaders(headers, "  tk_padded  ");
    expect(headers.get("Authorization")).toBe("Bearer tk_padded");
  });
});

describe("resolveAuthToken", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.TENKI_AUTH_TOKEN;
    delete process.env.TENKI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("accepts apiKey as an alias for authToken", () => {
    expect(resolveAuthToken(undefined, "tk_alias")).toBe("tk_alias");
    expect(resolveAuthToken("tk_same", "tk_same")).toBe("tk_same");
  });

  // Pre-1.0.7 callers could pass an ignored apiKey alongside authToken; authToken still wins.
  it("prefers authToken over the apiKey alias", () => {
    expect(resolveAuthToken("tk_one", "tk_two")).toBe("tk_one");
  });

  it("validates the alias like authToken", () => {
    expect(() => resolveAuthToken(undefined, "ory_st_test")).toThrow(InvalidAuthTokenError);
  });

  it("prefers an explicit apiKey over the environment", () => {
    process.env.TENKI_AUTH_TOKEN = "tk_env";
    expect(resolveAuthToken(undefined, "tk_explicit")).toBe("tk_explicit");
  });

  it("falls back to the environment", () => {
    process.env.TENKI_API_KEY = "tk_env_key";
    expect(resolveAuthToken()).toBe("tk_env_key");
    expect(resolveAuthToken(undefined, "  ")).toBe("tk_env_key");
  });

  it("requires a credential", () => {
    expect(() => resolveAuthToken()).toThrow(MissingAuthTokenError);
  });

  // Parity guard: must match the Python SDK's resolve_auth_token for blank values.
  it.each(["", "   ", "\t\n"])("treats blank credential %j as absent", (blank) => {
    process.env.TENKI_AUTH_TOKEN = "tk_env";
    expect(resolveAuthToken("tk_real", blank)).toBe("tk_real");
    expect(resolveAuthToken(blank, "tk_real")).toBe("tk_real");
    expect(resolveAuthToken(blank)).toBe("tk_env");
    expect(resolveAuthToken(undefined, blank)).toBe("tk_env");
  });

  it("trims padded values instead of reporting a conflict", () => {
    expect(resolveAuthToken(" tk_same ", "tk_same")).toBe("tk_same");
  });
});

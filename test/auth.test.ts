import { describe, expect, it } from "vitest";

import { setAuthHeaders } from "../src/auth.js";
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

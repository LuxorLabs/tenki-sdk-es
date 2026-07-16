import { describe, expect, it } from "vitest";

import { setAuthHeaders } from "../src/auth.js";

describe("setAuthHeaders", () => {
  it("sets Bearer for tk_ tokens", () => {
    const h = new Headers();
    setAuthHeaders(h, "tk_abc123", "session_cookie");
    expect(h.get("Authorization")).toBe("Bearer tk_abc123");
    expect(h.get("X-Session-Token")).toBeNull();
    expect(h.get("Cookie")).toBeNull();
  });

  it("sets X-Session-Token for ory_st_ tokens", () => {
    const h = new Headers();
    setAuthHeaders(h, "ory_st_xyz", "session_cookie");
    expect(h.get("X-Session-Token")).toBe("ory_st_xyz");
    expect(h.get("Authorization")).toBeNull();
  });

  it("sets Cookie for other tokens", () => {
    const h = new Headers();
    setAuthHeaders(h, "some_session_value", "my_cookie");
    expect(h.get("Cookie")).toBe("my_cookie=some_session_value");
    expect(h.get("Authorization")).toBeNull();
  });

  it("does nothing for empty token", () => {
    const h = new Headers();
    setAuthHeaders(h, "", "session_cookie");
    expect(h.get("Authorization")).toBeNull();
    expect(h.get("X-Session-Token")).toBeNull();
    expect(h.get("Cookie")).toBeNull();
  });

  it("trims whitespace", () => {
    const h = new Headers();
    setAuthHeaders(h, "  tk_padded  ", "c");
    expect(h.get("Authorization")).toBe("Bearer tk_padded");
  });
});

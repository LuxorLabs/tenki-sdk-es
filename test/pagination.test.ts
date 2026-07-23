import { describe, expect, it } from "vitest";

import { PaginationStalledError } from "../src/index.js";
import { advancePageToken } from "../src/pagination.js";

describe("automatic pagination", () => {
  it("normalizes advancing tokens and rejects repeated tokens", () => {
    expect(advancePageToken("", " next ")).toBe("next");
    expect(() => advancePageToken("next", " next ")).toThrow(PaginationStalledError);
  });
});

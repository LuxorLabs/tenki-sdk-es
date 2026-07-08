import { describe, expect, it } from "vitest";

import { Byte, GB, GiB, KB, KiB, MB, MiB, TB, TiB } from "../src/constants.js";

describe("size constants", () => {
  it("decimal units", () => {
    expect(Byte).toBe(1);
    expect(KB).toBe(1_000);
    expect(MB).toBe(1_000_000);
    expect(GB).toBe(1_000_000_000);
    expect(TB).toBe(1_000_000_000_000);
  });

  it("binary units", () => {
    expect(KiB).toBe(1024);
    expect(MiB).toBe(1024 * 1024);
    expect(GiB).toBe(1024 * 1024 * 1024);
    expect(TiB).toBe(1024 * 1024 * 1024 * 1024);
  });
});

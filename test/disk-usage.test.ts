import { describe, expect, it } from "vitest";

import { diskUsedBytes, diskUsedPercent, isDiskExhausted } from "../src/disk.js";
import type { DiskUsage } from "../src/disk.js";

const TOTAL = 5 * 1024 ** 3;

describe("isDiskExhausted", () => {
  it("reads an unreported disk as healthy", () => {
    expect(isDiskExhausted(undefined)).toBe(false);
    expect(isDiskExhausted({ totalBytes: 0, freeBytes: 0, availableBytes: 0, minAvailableBytes: 0 })).toBe(false);
  });

  it("leaves a healthy run alone", () => {
    const disk: DiskUsage = {
      totalBytes: TOTAL,
      freeBytes: 0,
      availableBytes: 2 * 1024 ** 3,
      minAvailableBytes: 2 * 1024 ** 3,
    };
    expect(isDiskExhausted(disk)).toBe(false);
  });

  it("flags a run that filled the disk and then cleaned up after itself", () => {
    // npm hits ENOSPC while unpacking, prints it as a warning, exits 0, and
    // frees enough on the way out that the exit-time reading looks survivable.
    // Only the low-water mark shows the run was defeated.
    const disk: DiskUsage = {
      totalBytes: TOTAL,
      freeBytes: 0,
      availableBytes: 214 * 1024 ** 2,
      minAvailableBytes: 0,
    };
    expect(isDiskExhausted(disk)).toBe(true);
  });

  it("flags a near-zero floor", () => {
    // Allocators give up short of the last byte, so a disk that is full from
    // the workload's point of view still reports a few MiB free.
    const disk: DiskUsage = {
      totalBytes: TOTAL,
      freeBytes: 0,
      availableBytes: 4 * 1024 ** 2,
      minAvailableBytes: 4 * 1024 ** 2,
    };
    expect(isDiskExhausted(disk)).toBe(true);
  });

  it("leaves headroom above the floor alone", () => {
    const disk: DiskUsage = {
      totalBytes: TOTAL,
      freeBytes: 0,
      availableBytes: 64 * 1024 ** 2,
      minAvailableBytes: 64 * 1024 ** 2,
    };
    expect(isDiskExhausted(disk)).toBe(false);
  });
});

describe("diskUsedBytes / diskUsedPercent", () => {
  it("counts usage the way df does, excluding the reserve", () => {
    // Real numbers from a 5 GiB sandbox: df reports 1963040768 used and
    // 2948128768 available, with 285212672 held back as the reserve. Counting
    // the reserve as used would report 43% where df prints 40%.
    const disk: DiskUsage = {
      totalBytes: 5196382208,
      freeBytes: 2948128768 + 285212672,
      availableBytes: 2948128768,
      minAvailableBytes: 2948128768,
    };
    expect(diskUsedBytes(disk)).toBe(1963040768);
    expect(diskUsedPercent(disk)).toBeGreaterThan(39.5);
    expect(diskUsedPercent(disk)).toBeLessThan(40.5);
  });

  it("overstates rather than invents headroom on a guest without freeBytes", () => {
    const disk: DiskUsage = {
      totalBytes: TOTAL,
      freeBytes: 0,
      availableBytes: 2 * 1024 ** 3,
      minAvailableBytes: 2 * 1024 ** 3,
    };
    expect(diskUsedBytes(disk)).toBe(3 * 1024 ** 3);
    expect(diskUsedPercent(disk)).toBeGreaterThan(59.5);
  });

  it("guards an unknown disk", () => {
    expect(diskUsedBytes(undefined)).toBe(0);
    expect(diskUsedPercent(undefined)).toBe(0);
  });
});

/** Sandbox filesystem state observed while a command ran. */
export interface DiskUsage {
  totalBytes: number;
  /**
   * Counts the filesystem reserve that `availableBytes` excludes.
   * `freeBytes - availableBytes` is the reserve itself, which is why a
   * root-owned write can still land on a filesystem the workload sees as full.
   * Zero from a guest too old to report it.
   */
  freeBytes: number;
  /**
   * Free space when the command exited, excluding the reserve: what the
   * workload itself can still write.
   */
  availableBytes: number;
  /**
   * Least free space seen while the command ran. This is the field that
   * identifies a run defeated by a full disk: pip, npm and containerd all
   * delete their partial downloads after hitting ENOSPC, so `availableBytes`
   * recovers before the command exits and only this stays low.
   * `session.diskUsage()` takes a single sample, so there it equals
   * `availableBytes`.
   */
  minAvailableBytes: number;
}

/**
 * Free-space floor under which a run is treated as having exhausted the disk.
 * Not zero: allocators fail short of the last byte, and ext4 keeps a root
 * reserve the workload cannot touch, so a workload-visible "full" disk still
 * reports a small non-zero available figure.
 */
const DISK_EXHAUSTION_AVAILABLE_BYTES = 16 * 1024 * 1024;

/**
 * Whether the sandbox filesystem ran out of usable space at any point during
 * the command. Deliberately independent of exit status: npm hits ENOSPC while
 * unpacking, prints it as a warning and still exits 0, leaving a broken install
 * behind, so a caller that only checks this on failure misses the case that is
 * hardest to diagnose.
 */
export function isDiskExhausted(disk: DiskUsage | undefined): boolean {
  if (!disk || disk.totalBytes <= 0) return false;
  return disk.minAvailableBytes < DISK_EXHAUSTION_AVAILABLE_BYTES;
}

/**
 * Space consumed, counted as df does: total minus free, so the reserve is
 * neither used nor available. A guest too old to report `freeBytes` falls back
 * to treating the reserve as used, which overstates usage rather than inventing
 * headroom.
 */
export function diskUsedBytes(disk: DiskUsage | undefined): number {
  if (!disk || disk.totalBytes <= 0) return 0;
  const free = disk.freeBytes > 0 ? disk.freeBytes : disk.availableBytes;
  return disk.totalBytes - free;
}

/** Usage as df reports it, against usable capacity rather than raw total. */
export function diskUsedPercent(disk: DiskUsage | undefined): number {
  const used = diskUsedBytes(disk);
  const usable = used + (disk?.availableBytes ?? 0);
  if (usable <= 0) return 0;
  return (used / usable) * 100;
}

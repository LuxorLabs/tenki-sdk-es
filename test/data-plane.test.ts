import { afterEach, describe, expect, it, vi } from "vitest";

import { DataPlaneCredentialManager } from "../src/data-plane.js";
import { InvalidStateError } from "../src/errors.js";

describe("DataPlaneCredentialManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("backs off when credential renewal returns false", async () => {
    vi.useFakeTimers();
    const renewDataPlaneCredential = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const manager = new DataPlaneCredentialManager({ renewDataPlaneCredential } as never);

    const renewLoop = (manager as unknown as { renewLoop: () => Promise<void> }).renewLoop();
    await vi.waitFor(() => expect(renewDataPlaneCredential).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(999);
    expect(renewDataPlaneCredential).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await renewLoop;
    expect(renewDataPlaneCredential).toHaveBeenCalledTimes(2);
  });

  it("stops when credential renewal sees a paused session", async () => {
    vi.useFakeTimers();
    const renewDataPlaneCredential = vi
      .fn()
      .mockRejectedValue(new InvalidStateError("session not RUNNING (state=PAUSED)"));
    const manager = new DataPlaneCredentialManager({ renewDataPlaneCredential } as never);

    const renewLoop = (manager as unknown as { renewLoop: () => Promise<void> }).renewLoop();
    await vi.waitFor(() => expect(renewDataPlaneCredential).toHaveBeenCalledTimes(1));

    await renewLoop;
    expect(renewDataPlaneCredential).toHaveBeenCalledTimes(1);
  });

  it("retries creating and resuming invalid states", async () => {
    vi.useFakeTimers();
    const renewDataPlaneCredential = vi
      .fn()
      .mockRejectedValueOnce(new InvalidStateError("session not RUNNING (state=CREATING)"))
      .mockRejectedValueOnce(new InvalidStateError("session not RUNNING (state=RESUMING)"))
      .mockResolvedValueOnce(true);
    const manager = new DataPlaneCredentialManager({ renewDataPlaneCredential } as never);

    const renewLoop = (manager as unknown as { renewLoop: () => Promise<void> }).renewLoop();
    await vi.waitFor(() => expect(renewDataPlaneCredential).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(renewDataPlaneCredential).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(2_000);
    await renewLoop;

    expect(renewDataPlaneCredential).toHaveBeenCalledTimes(3);
  });
});

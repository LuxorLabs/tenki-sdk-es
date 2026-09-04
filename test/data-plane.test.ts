import { Http2SessionManager } from "@connectrpc/connect-node";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeDataPlaneConnection,
  createDataPlaneClient,
  DataPlaneCredentialManager,
  DataPlaneEndpointHints,
} from "../src/data-plane.js";
import { InvalidStateError } from "../src/errors.js";

describe("DataPlaneCredentialManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("closes the session manager with the data-plane client", () => {
    const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
    const client = createDataPlaneClient("https://sandbox.example.com", { current: () => "credential" } as never);

    closeDataPlaneConnection(client);
    closeDataPlaneConnection(client);

    expect(abort).toHaveBeenCalledOnce();
  });

  it("shares one session manager for clients on the same origin", () => {
    const abort = vi.spyOn(Http2SessionManager.prototype, "abort");
    const first = createDataPlaneClient("https://sandbox.example.com", { current: () => "first" } as never);
    const second = createDataPlaneClient("https://sandbox.example.com/", { current: () => "second" } as never);

    closeDataPlaneConnection(first);
    expect(abort).not.toHaveBeenCalled();

    closeDataPlaneConnection(second);
    expect(abort).toHaveBeenCalledOnce();
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

describe("DataPlaneEndpointHints", () => {
  it("clears a remembered endpoint", () => {
    const hints = new DataPlaneEndpointHints();
    hints.remember("https://node.test");

    hints.clear();

    expect(hints.current()).toBe("");
  });

  it("singleflights concurrent endpoint discovery", async () => {
    const hints = new DataPlaneEndpointHints();
    let release!: (endpoint: string) => void;
    const discovered = new Promise<string>((resolve) => {
      release = resolve;
    });
    const resolveEndpoint = vi.fn(() => discovered);

    const first = hints.resolve(resolveEndpoint);
    const second = hints.resolve(resolveEndpoint);
    release("https://data-plane.test");

    await expect(Promise.all([first, second])).resolves.toEqual(["https://data-plane.test", "https://data-plane.test"]);
    expect(resolveEndpoint).toHaveBeenCalledOnce();
    expect(hints.current()).toBe("https://data-plane.test");
  });

  it("lets waiters retry when the resolver owner fails", async () => {
    const hints = new DataPlaneEndpointHints();
    let calls = 0;
    const resolveEndpoint = vi.fn(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (calls === 1) throw new Error("transient resolver failure");
      return "https://data-plane.test";
    });

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => hints.resolve(resolveEndpoint)));

    expect(resolveEndpoint).toHaveBeenCalledTimes(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled").map((result) => result.value)).toEqual(
      Array.from({ length: 7 }, () => "https://data-plane.test"),
    );
  });
});

import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { FileTooLargeError, mapError, QuotaExceededError } from "../src/errors.js";
import { FileTooLargeError as PublicFileTooLargeError } from "../src/index.js";

// Node-agent wire text for a refused unary ReadFile; the Go and Python SDK tests use the same string.
const fileTooLargeWireText =
  "file too large for ReadFile: size_bytes=1100000000 max_bytes=33554432; use ReadFileStream";

describe("FileTooLargeError", () => {
  it("maps a refused unary read with its sizes", () => {
    const mapped = mapError(new ConnectError(fileTooLargeWireText, Code.ResourceExhausted));

    expect(mapped).toBeInstanceOf(FileTooLargeError);
    expect(mapped).toBeInstanceOf(PublicFileTooLargeError);
    expect(mapped).not.toBeInstanceOf(QuotaExceededError);
    const tooLarge = mapped as FileTooLargeError;
    expect(tooLarge.operation).toBe("ReadFile");
    expect(tooLarge.sizeBytes).toBe(1100000000n);
    expect(tooLarge.maxBytes).toBe(33554432n);
    expect(tooLarge.name).toBe("FileTooLargeError");
  });

  it("maps a refused unary write", () => {
    const mapped = mapError(
      new ConnectError(
        "file too large for WriteFile: size_bytes=94371840 max_bytes=33554432; use WriteFileStream",
        Code.ResourceExhausted,
      ),
    );

    expect(mapped).toBeInstanceOf(FileTooLargeError);
    expect((mapped as FileTooLargeError).operation).toBe("WriteFile");
    expect((mapped as FileTooLargeError).sizeBytes).toBe(94371840n);
  });

  it("does not type a size with more digits than an int64 holds", () => {
    const mapped = mapError(
      new ConnectError(
        "file too large for ReadFile: size_bytes=12345678901234567890 max_bytes=33554432; use ReadFileStream",
        Code.ResourceExhausted,
      ),
    );

    expect(mapped).not.toBeInstanceOf(FileTooLargeError);
  });

  it("keeps other resource exhaustion as a quota error", () => {
    const mapped = mapError(new ConnectError("workspace quota exceeded", Code.ResourceExhausted));

    expect(mapped).toBeInstanceOf(QuotaExceededError);
    expect(mapped).not.toBeInstanceOf(FileTooLargeError);
  });
});

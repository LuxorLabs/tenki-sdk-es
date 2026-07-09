import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { InvalidResourceConfigError } from "../src/errors.js";

const connectMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  createGrpcTransport: vi.fn(() => ({ kind: "transport" })),
}));

vi.mock("@connectrpc/connect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@connectrpc/connect")>();
  return {
    ...actual,
    createClient: connectMock.createClient,
  };
});

vi.mock("@connectrpc/connect-node", () => ({
  createGrpcTransport: connectMock.createGrpcTransport,
}));

describe("TenkiSandbox client TLS options", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes root certificates to the default gRPC transport", () => {
    const rootCertificates = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";

    new TenkiSandbox({ authToken: "tk_test", rootCertificates });

    expect(connectMock.createGrpcTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeOptions: { ca: rootCertificates },
      }),
    );
  });

  it("rejects invalid create resources before RPC", async () => {
    const createSession = vi.fn();
    connectMock.createClient.mockReturnValue({ createSession });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(client.create({ cpuCores: 17 })).rejects.toThrow(InvalidResourceConfigError);
    await expect(client.create({ memoryMb: 8089 })).rejects.toThrow(InvalidResourceConfigError);
    await expect(client.create({ diskSizeGb: 3 })).rejects.toThrow(InvalidResourceConfigError);

    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects invalid template resources before RPC", async () => {
    const createTemplate = vi.fn();
    connectMock.createClient.mockReturnValue({ createTemplate });
    const client = new TenkiSandbox({ authToken: "tk_test" });

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 8089 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 128 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    await expect(
      client.createTemplate({
        workspaceId: "019f191e-020e-7f73-a647-498d954be5e6",
        name: "invalid",
        resources: { cpuCores: 4, memoryMb: 4096, diskSizeGb: 4 },
      }),
    ).rejects.toThrow(InvalidResourceConfigError);

    expect(createTemplate).not.toHaveBeenCalled();
  });
});

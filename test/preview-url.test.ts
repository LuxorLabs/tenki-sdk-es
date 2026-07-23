import { describe, expect, it, vi } from "vitest";

import { PreviewUrlClient } from "../src/preview-url.js";

describe("PreviewUrlClient workspace scope", () => {
  it("creates and lists preview URLs without Project scope", async () => {
    const createPreviewUrl = vi.fn(async (request: { workspaceId?: string; projectId?: string }) => ({
      previewUrl: { id: "preview-1", workspaceId: request.workspaceId },
    }));
    const listPreviewUrls = vi.fn(async (request: { workspaceId?: string; projectId?: string }) => ({
      previewUrls: [],
      nextPageToken: "",
    }));
    const client = new PreviewUrlClient({ createPreviewUrl, listPreviewUrls } as never);

    await client.create("demo");
    await client.list();

    expect(createPreviewUrl).toHaveBeenCalledWith(expect.objectContaining({ projectId: "" }));
    expect(createPreviewUrl.mock.calls[0]?.[0].workspaceId).toBeUndefined();
    expect(listPreviewUrls).toHaveBeenCalledWith(expect.objectContaining({ projectId: "" }));
    expect(listPreviewUrls.mock.calls[0]?.[0].workspaceId).toBeUndefined();
  });

  it("supports explicit service-token workspace scope and drains every page", async () => {
    const createPreviewUrl = vi.fn(async () => ({ previewUrl: { id: "preview-1" } }));
    const listPreviewUrls = vi.fn(async (request: { workspaceId?: string; pageToken?: string }) =>
      request.pageToken
        ? { previewUrls: [{ id: "preview-2" }], nextPageToken: "" }
        : { previewUrls: [{ id: "preview-1" }], nextPageToken: "next" },
    );
    const client = new PreviewUrlClient({ createPreviewUrl, listPreviewUrls } as never);

    await client.create("demo", { workspaceId: "workspace-1" });
    const previewUrls = await client.list({ workspaceId: "workspace-1" });

    expect(createPreviewUrl).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" }));
    expect(listPreviewUrls.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ workspaceId: "workspace-1", pageSize: 100, pageToken: "" }),
    );
    expect(listPreviewUrls.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ workspaceId: "workspace-1", pageSize: 100, pageToken: "next" }),
    );
    expect(previewUrls.map((item) => item.id)).toEqual(["preview-1", "preview-2"]);
  });
});

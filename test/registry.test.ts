import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import { PermissionDeniedError, RegistryImageNotFoundError, TemplateRuntimeFailedError } from "../src/errors.js";
import {
  DeleteRegistryImageResponseSchema,
  DeleteRegistryImageVersionResponseSchema,
  GetRegistryImageResponseSchema,
  ListRegistryImagesResponseSchema,
  ListRegistryShareGrantsResponseSchema,
  PublishRegistryImageResponseSchema,
  RegistryImageKind,
  RegistryImageSchema,
  RegistryImageSummarySchema,
  RegistryShareGrantSchema,
  RegistrySortBy,
  RegistryTagSchema,
  RegistryVisibility,
  ResolvedRegistryRefSchema,
  ResolveRegistryRefResponseSchema,
  RevokeRegistryShareGrantResponseSchema,
  SetRegistryImageVisibilityResponseSchema,
  ShareImageResponseSchema,
  UnshareRegistryImageResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/registry_pb.js";
import {
  CreateSessionResponseSchema,
  SandboxSessionSchema,
  SessionState,
  TemplateRuntimeFailureSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import { TemplateRuntimeState } from "../src/internal/proto/tenki/sandbox/v1/template_pb.js";

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

describe("TenkiSandbox registry APIs", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates sessions from user-facing image refs via registry_ref", async () => {
    const rpcClient = makeRpcClient({
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.RUNNING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
    });

    await makeSdk(rpcClient).create({ workspaceId: "workspace-1", image: "pub/polyglot:prod" });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request).toEqual(expect.objectContaining({ registryRef: "pub/polyglot:prod" }));
    expect(request.waitReady).toBe(true);
    expect(request.cpuCores).toBeUndefined();
    expect(request.memoryMb).toBeUndefined();
    expect(request.diskSizeGb).toBeUndefined();
    expect(request.templateId).toBeUndefined();
    expect(request.snapshotId).toBeUndefined();
  });

  it("creates sessions directly from typed template specs", async () => {
    const rpcClient = makeRpcClient({
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.RUNNING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
    });

    await makeSdk(rpcClient).create({
      workspaceId: "workspace-1",
      fromTemplateSpec: "8d995c1c-8e24-4b3a-a8ab-a00316357385",
      setupEnv: { MODE: "dev" },
      setupSecrets: { GH_TOKEN: "secret" },
    });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.templateSpecId).toBe("8d995c1c-8e24-4b3a-a8ab-a00316357385");
    expect(request.setupEnv).toEqual({ MODE: "dev" });
    expect(request.setupSecrets).toEqual({ GH_TOKEN: "secret" });
    expect(request.cpuCores).toBeUndefined();
    expect(request.memoryMb).toBeUndefined();
    expect(request.diskSizeGb).toBeUndefined();
  });

  it("rejects conflicting template spec sources", async () => {
    const rpcClient = makeRpcClient();

    await expect(
      makeSdk(rpcClient).create({
        workspaceId: "workspace-1",
        image: "acme/app:latest",
        fromTemplateSpec: "8d995c1c-8e24-4b3a-a8ab-a00316357385",
      }),
    ).rejects.toThrow("Only one of image, snapshotId, or fromTemplateSpec may be set");
    expect(rpcClient.createSession).not.toHaveBeenCalled();
  });

  it("can opt out of create readiness waiting", async () => {
    const rpcClient = makeRpcClient({
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.CREATING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
    });

    await makeSdk(rpcClient).create({ workspaceId: "workspace-1", image: "pub/polyglot:prod", waitReady: false });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.waitReady).toBe(false);
  });

  it("can wait for an image runtime", async () => {
    const rpcClient = makeRpcClient({
      createSession: vi.fn(async () =>
        create(CreateSessionResponseSchema, {
          session: create(SandboxSessionSchema, {
            id: "session-1",
            state: SessionState.RUNNING,
            ownerType: "SERVICE",
            ownerId: "self",
          }),
        }),
      ),
    });

    await makeSdk(rpcClient).create({
      workspaceId: "workspace-1",
      image: "pub/polyglot:prod",
      waitForRuntime: true,
    });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.waitForRuntime).toBe(true);
  });

  it("returns typed image runtime failures with the running session", async () => {
    const failure = {
      session: create(SandboxSessionSchema, {
        id: "session-1",
        state: SessionState.RUNNING,
        runtimeState: TemplateRuntimeState.FAILED,
      }),
      reason: "runtime readiness deadline exceeded",
    };
    const rpcClient = makeRpcClient({
      createSession: vi.fn(async () => {
        throw new ConnectError("template runtime failed", Code.FailedPrecondition, undefined, [
          { desc: TemplateRuntimeFailureSchema, value: failure },
        ]);
      }),
    });

    const err = await makeSdk(rpcClient)
      .create({ workspaceId: "workspace-1", image: "pub/polyglot:prod", waitForRuntime: true })
      .catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(TemplateRuntimeFailedError);
    expect(err).toMatchObject({
      message: "runtime readiness deadline exceeded",
      session: { id: "session-1", state: "RUNNING", runtimeState: "FAILED" },
    });
  });

  it("lists registry images with discovery filters", async () => {
    const rpcClient = makeRpcClient({
      listRegistryImages: vi.fn(async () =>
        create(ListRegistryImagesResponseSchema, {
          images: [
            create(RegistryImageSummarySchema, {
              id: "image-1",
              workspaceId: "workspace-1",
              workspaceSlug: "pub",
              name: "polyglot",
              kind: RegistryImageKind.TEMPLATE,
              visibility: RegistryVisibility.PUBLIC,
              labels: ["node"],
              latestSnapshotId: "snapshot-1",
              latestRef: "pub/polyglot:prod",
              changesNotYetPublished: true,
            }),
          ],
          nextCursor: "next",
        }),
      ),
    });

    const result = await makeSdk(rpcClient).listRegistryImages({
      workspace: " pub ",
      labels: [" node ", ""],
      kind: "template",
      nameSubstring: " poly ",
      sort: "name",
      pageSize: 25,
      cursor: " cursor ",
    });

    expect(rpcClient.listRegistryImages).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceSlug: "pub",
        labels: ["node"],
        kind: RegistryImageKind.TEMPLATE,
        nameSubstring: "poly",
        sortBy: RegistrySortBy.NAME,
        pageSize: 25,
        cursor: "cursor",
      }),
    );
    expect(result.images[0]).toMatchObject({
      id: "image-1",
      kind: "template",
      visibility: "public",
      latestRef: "pub/polyglot:prod",
      changesNotYetPublished: true,
    });
    expect(result.nextCursor).toBe("next");
  });

  it("gets registry images by image ref or id", async () => {
    const rpcClient = makeRpcClient({
      getRegistryImage: vi.fn(async () =>
        create(GetRegistryImageResponseSchema, {
          detail: {
            image: makeImage(),
            resolvedSnapshotId: "snapshot-1",
            resolvedRef: "pub/polyglot:prod",
            workspaceActive: true,
            maskedEnvVarKeys: ["TOKEN"],
            metadata: { a: "b" },
          },
        }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const byImage = await sdk.getRegistryImage("pub/polyglot:prod", { workspaceId: "workspace-1" });
    await sdk.getRegistryImage("018f26e2-2ed4-7b3d-8000-c38ab60d91c6");

    expect(rpcClient.getRegistryImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ref: "pub/polyglot:prod", workspaceId: "workspace-1" }),
    );
    expect(rpcClient.getRegistryImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ imageId: "018f26e2-2ed4-7b3d-8000-c38ab60d91c6" }),
    );
    expect(byImage).toMatchObject({
      resolvedRef: "pub/polyglot:prod",
      maskedEnvVarKeys: ["TOKEN"],
      metadata: { a: "b" },
      image: { name: "polyglot" },
    });
  });

  it("resolves registry images", async () => {
    const rpcClient = makeRpcClient({
      resolveRegistryRef: vi.fn(async () =>
        create(ResolveRegistryRefResponseSchema, {
          resolved: create(ResolvedRegistryRefSchema, {
            imageId: "image-1",
            owningWorkspaceId: "workspace-1",
            owningWorkspaceSlug: "pub",
            imageName: "polyglot",
            tag: "prod",
            snapshotId: "snapshot-1",
            kind: RegistryImageKind.TEMPLATE,
            visibility: RegistryVisibility.PUBLIC,
          }),
        }),
      ),
    });

    const resolved = await makeSdk(rpcClient).resolveRegistryRef(" pub/polyglot:prod ", {
      workspaceId: "workspace-1",
    });

    expect(rpcClient.resolveRegistryRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "pub/polyglot:prod", workspaceId: "workspace-1" }),
    );
    expect(resolved).toMatchObject({
      imageId: "image-1",
      snapshotId: "snapshot-1",
      resolvedRef: "pub/polyglot:prod",
      kind: "template",
      visibility: "public",
    });
  });

  it("returns canonical resolved refs for bare registry images", async () => {
    const rpcClient = makeRpcClient({
      resolveRegistryRef: vi.fn(async () =>
        create(ResolveRegistryRefResponseSchema, {
          resolved: create(ResolvedRegistryRefSchema, {
            imageId: "image-1",
            owningWorkspaceId: "workspace-1",
            owningWorkspaceSlug: "pub",
            imageName: "polyglot",
            tag: "prod",
            snapshotId: "snapshot-1",
            kind: RegistryImageKind.TEMPLATE,
            visibility: RegistryVisibility.PUBLIC,
          }),
        }),
      ),
    });

    const resolved = await makeSdk(rpcClient).resolveRegistryRef("pub/polyglot");

    expect(rpcClient.resolveRegistryRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "pub/polyglot" }));
    expect(resolved.resolvedRef).toBe("pub/polyglot:prod");
  });

  it("publishes template and snapshot registry images", async () => {
    const rpcClient = makeRpcClient({
      publishRegistryImage: vi.fn(async () =>
        create(PublishRegistryImageResponseSchema, {
          image: makeImage(),
          tag: create(RegistryTagSchema, {
            id: "tag-1",
            imageId: "image-1",
            tag: "prod",
            snapshotId: "snapshot-1",
            ref: "pub/polyglot:prod",
          }),
          snapshotId: "snapshot-1",
          digestRef: "pub/polyglot@snapshot-1",
        }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const published = await sdk.publishRegistryImage({
      image: "pub/polyglot",
      fromTemplateId: "template-1",
      tag: "prod",
      visibility: "public",
      labels: [" ci "],
      title: "Polyglot",
    });
    await sdk.publishRegistryImage({
      workspaceId: "workspace-1",
      name: "debug",
      fromSnapshotId: "snapshot-2",
    });

    expect(rpcClient.publishRegistryImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ref: "pub/polyglot",
        sourceTemplateId: "template-1",
        kind: RegistryImageKind.TEMPLATE,
        tag: "prod",
        visibility: RegistryVisibility.PUBLIC,
        labels: ["ci"],
        title: "Polyglot",
      }),
    );
    expect(rpcClient.publishRegistryImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "workspace-1",
        name: "debug",
        snapshotId: "snapshot-2",
        kind: RegistryImageKind.SNAPSHOT,
      }),
    );
    expect(published).toMatchObject({
      snapshotId: "snapshot-1",
      digestRef: "pub/polyglot@snapshot-1",
      tag: { ref: "pub/polyglot:prod" },
    });
  });

  it("unpublishes by image after stripping tag refs", async () => {
    const rpcClient = makeRpcClient({
      setRegistryImageVisibility: vi.fn(async () =>
        create(SetRegistryImageVisibilityResponseSchema, {
          image: makeImage(),
        }),
      ),
    });

    const image = await makeSdk(rpcClient).unpublishRegistryImage("pub/polyglot:prod");

    expect(rpcClient.setRegistryImageVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "pub/polyglot",
        visibility: RegistryVisibility.PRIVATE,
      }),
    );
    expect(image.name).toBe("polyglot");
  });

  it("shares registry images with target workspace ids", async () => {
    const rpcClient = makeRpcClient({
      shareImage: vi.fn(async () =>
        create(ShareImageResponseSchema, {
          image: makeImage(),
          currentSnapshotId: "snapshot-1",
          digestRef: "pub/polyglot@snapshot-1",
          grant: makeShareGrant(),
        }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const shared = await sdk.shareImage(" pub/polyglot ", {
      targetWorkspaceId: " target-workspace ",
      tag: " prod ",
    });

    expect(rpcClient.shareImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRef: "pub/polyglot",
        targetWorkspaceId: "target-workspace",
        tag: "prod",
      }),
    );
    expect(shared).toMatchObject({
      image: { name: "polyglot" },
      currentSnapshotId: "snapshot-1",
      digestRef: "pub/polyglot@snapshot-1",
      grant: { targetWorkspaceId: "target-workspace" },
    });
  });

  it("lists and revokes registry share grants", async () => {
    const rpcClient = makeRpcClient({
      listRegistryShareGrants: vi.fn(async () =>
        create(ListRegistryShareGrantsResponseSchema, { grants: [makeShareGrant()] }),
      ),
      revokeRegistryShareGrant: vi.fn(async () =>
        create(RevokeRegistryShareGrantResponseSchema, { grant: makeShareGrant() }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const grants = await sdk.listRegistryShareGrants("018f26e2-2ed4-7b3d-8000-c38ab60d91c6");
    const grant = await sdk.revokeRegistryShareGrant("grant-1", " cleanup ");

    expect(rpcClient.listRegistryShareGrants).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: "018f26e2-2ed4-7b3d-8000-c38ab60d91c6" }),
    );
    expect(rpcClient.revokeRegistryShareGrant).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "grant-1", reason: "cleanup" }),
    );
    expect(grants[0]).toMatchObject({ id: "grant-1" });
    expect(grant).toMatchObject({ id: "grant-1" });
  });

  it("unshares registry images", async () => {
    const rpcClient = makeRpcClient({
      unshareRegistryImage: vi.fn(async () =>
        create(UnshareRegistryImageResponseSchema, {
          image: makeImage(),
          revokedTokenCount: 1,
          revokedGrantCount: 2,
        }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const unshare = await sdk.unshareRegistryImage("pub/polyglot", " cleanup ");

    expect(rpcClient.unshareRegistryImage).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "pub/polyglot", reason: "cleanup" }),
    );
    expect(unshare).toMatchObject({ revokedTokenCount: 1, revokedGrantCount: 2 });
  });

  it("deletes registry images", async () => {
    const rpcClient = makeRpcClient({
      deleteRegistryImage: vi.fn(async () =>
        create(DeleteRegistryImageResponseSchema, {
          image: makeImage(),
          revokedTokenCount: 1,
          revokedGrantCount: 2,
        }),
      ),
    });
    const sdk = makeSdk(rpcClient);

    const deleted = await sdk.deleteRegistryImage("018f26e2-2ed4-7b3d-8000-c38ab60d91c6", " cleanup ");

    expect(rpcClient.deleteRegistryImage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageId: "018f26e2-2ed4-7b3d-8000-c38ab60d91c6",
        reason: "cleanup",
      }),
    );
    expect(deleted).toMatchObject({ revokedTokenCount: 1, revokedGrantCount: 2 });
  });

  it("deletes registry image versions", async () => {
    const rpcClient = makeRpcClient({
      deleteRegistryImageVersion: vi.fn(async () =>
        create(DeleteRegistryImageVersionResponseSchema, {
          imageId: "image-1",
          snapshotId: "snapshot-1",
        }),
      ),
    });

    const deleted = await makeSdk(rpcClient).deleteRegistryImageVersion(" image-1 ", " snapshot-1 ");

    expect(rpcClient.deleteRegistryImageVersion).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: "image-1", snapshotId: "snapshot-1" }),
    );
    expect(deleted).toEqual({ imageId: "image-1", snapshotId: "snapshot-1" });
  });

  it.each([
    ["permission denied", Code.PermissionDenied, "registry image edit denied", PermissionDeniedError],
    ["registry image not found", Code.NotFound, "registry image version not found", RegistryImageNotFoundError],
  ])("maps registry image version deletion errors: %s", async (_name, code, message, expectedError) => {
    const rpcClient = makeRpcClient({
      deleteRegistryImageVersion: vi.fn(async () => {
        throw new ConnectError(message, code);
      }),
    });

    await expect(makeSdk(rpcClient).deleteRegistryImageVersion("image-1", "snapshot-1")).rejects.toBeInstanceOf(
      expectedError,
    );
  });
});

function makeSdk(rpcClient: ReturnType<typeof makeRpcClient>): TenkiSandbox {
  connectMock.createClient.mockReturnValue(rpcClient);
  return new TenkiSandbox({ authToken: "tk_test", transport: {} as never });
}

function makeRpcClient(overrides?: Record<string, unknown>) {
  return {
    createSession: vi.fn(),
    listRegistryImages: vi.fn(),
    getRegistryImage: vi.fn(),
    resolveRegistryRef: vi.fn(),
    publishRegistryImage: vi.fn(),
    setRegistryImageVisibility: vi.fn(),
    revokeRegistryShareGrant: vi.fn(),
    listRegistryShareGrants: vi.fn(),
    unshareRegistryImage: vi.fn(),
    deleteRegistryImage: vi.fn(),
    deleteRegistryImageVersion: vi.fn(),
    ...overrides,
  };
}

function makeImage() {
  return create(RegistryImageSchema, {
    id: "image-1",
    workspaceId: "workspace-1",
    workspaceSlug: "pub",
    name: "polyglot",
    kind: RegistryImageKind.TEMPLATE,
    visibility: RegistryVisibility.SHARED,
    labels: ["node"],
    changesNotYetPublished: false,
  });
}

function makeShareGrant() {
  return create(RegistryShareGrantSchema, {
    id: "grant-1",
    imageId: "image-1",
    ownerWorkspaceId: "workspace-1",
    targetWorkspaceId: "target-workspace",
    currentSnapshotId: "snapshot-1",
    grantedViaTokenId: "token-1",
  });
}

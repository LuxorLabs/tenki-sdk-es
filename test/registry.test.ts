import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TenkiSandbox } from "../src/client.js";
import {
  CreateSessionResponseSchema,
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
  SandboxSessionSchema,
  SessionState,
  SetRegistryImageVisibilityResponseSchema,
  ShareImageResponseSchema,
  UnshareRegistryImageResponseSchema,
} from "../src/internal/proto/tenki/sandbox/v1/sandbox_pb.js";

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

    await makeSdk(rpcClient).create({ image: "pub/polyglot:prod" });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request).toEqual(expect.objectContaining({ registryRef: "pub/polyglot:prod" }));
    expect(request.waitReady).toBe(true);
    expect(request.cpuCores).toBeUndefined();
    expect(request.memoryMb).toBeUndefined();
    expect(request.diskSizeGb).toBeUndefined();
    expect(request.templateId).toBeUndefined();
    expect(request.snapshotId).toBeUndefined();
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

    await makeSdk(rpcClient).create({ image: "pub/polyglot:prod", waitReady: false });

    const request = rpcClient.createSession.mock.calls[0]?.[0];
    expect(request.waitReady).toBe(false);
  });

  it("lists registry artifacts with discovery filters", async () => {
    const rpcClient = makeRpcClient({
      listRegistryImages: vi.fn(async () =>
        create(ListRegistryImagesResponseSchema, {
          artifacts: [
            create(RegistryImageSummarySchema, {
              id: "artifact-1",
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
    expect(result.artifacts[0]).toMatchObject({
      id: "artifact-1",
      kind: "template",
      visibility: "public",
      latestRef: "pub/polyglot:prod",
      changesNotYetPublished: true,
    });
    expect(result.nextCursor).toBe("next");
  });

  it("gets registry artifacts by image or artifact id", async () => {
    const rpcClient = makeRpcClient({
      getRegistryImage: vi.fn(async () =>
        create(GetRegistryImageResponseSchema, {
          detail: {
            artifact: makeArtifact(),
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

    const byImage = await sdk.getRegistryImage("pub/polyglot:prod");
    await sdk.getRegistryImage("018f26e2-2ed4-7b3d-8000-c38ab60d91c6");

    expect(rpcClient.getRegistryImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ref: "pub/polyglot:prod" }),
    );
    expect(rpcClient.getRegistryImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ artifactId: "018f26e2-2ed4-7b3d-8000-c38ab60d91c6" }),
    );
    expect(byImage).toMatchObject({
      resolvedRef: "pub/polyglot:prod",
      maskedEnvVarKeys: ["TOKEN"],
      metadata: { a: "b" },
      artifact: { name: "polyglot" },
    });
  });

  it("resolves registry images", async () => {
    const rpcClient = makeRpcClient({
      resolveRegistryRef: vi.fn(async () =>
        create(ResolveRegistryRefResponseSchema, {
          resolved: create(ResolvedRegistryRefSchema, {
            artifactId: "artifact-1",
            owningWorkspaceId: "workspace-1",
            owningWorkspaceSlug: "pub",
            artifactName: "polyglot",
            tag: "prod",
            snapshotId: "snapshot-1",
            kind: RegistryImageKind.TEMPLATE,
            visibility: RegistryVisibility.PUBLIC,
          }),
        }),
      ),
    });

    const resolved = await makeSdk(rpcClient).resolveRegistryRef(" pub/polyglot:prod ");

    expect(rpcClient.resolveRegistryRef).toHaveBeenCalledWith(expect.objectContaining({ ref: "pub/polyglot:prod" }));
    expect(resolved).toMatchObject({
      artifactId: "artifact-1",
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
            artifactId: "artifact-1",
            owningWorkspaceId: "workspace-1",
            owningWorkspaceSlug: "pub",
            artifactName: "polyglot",
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

  it("publishes template and snapshot registry artifacts", async () => {
    const rpcClient = makeRpcClient({
      publishRegistryImage: vi.fn(async () =>
        create(PublishRegistryImageResponseSchema, {
          artifact: makeArtifact(),
          tag: create(RegistryTagSchema, {
            id: "tag-1",
            artifactId: "artifact-1",
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
          artifact: makeArtifact(),
        }),
      ),
    });

    const artifact = await makeSdk(rpcClient).unpublishRegistryImage("pub/polyglot:prod");

    expect(rpcClient.setRegistryImageVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "pub/polyglot",
        visibility: RegistryVisibility.PRIVATE,
      }),
    );
    expect(artifact.name).toBe("polyglot");
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
      expect.objectContaining({ artifactId: "018f26e2-2ed4-7b3d-8000-c38ab60d91c6" }),
    );
    expect(rpcClient.revokeRegistryShareGrant).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: "grant-1", reason: "cleanup" }),
    );
    expect(grants[0]).toMatchObject({ id: "grant-1" });
    expect(grant).toMatchObject({ id: "grant-1" });
  });

  it("unshares registry artifacts", async () => {
    const rpcClient = makeRpcClient({
      unshareRegistryImage: vi.fn(async () =>
        create(UnshareRegistryImageResponseSchema, {
          artifact: makeArtifact(),
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
    ...overrides,
  };
}

function makeArtifact() {
  return create(RegistryImageSchema, {
    id: "artifact-1",
    workspaceId: "workspace-1",
    workspaceSlug: "pub",
    name: "polyglot",
    kind: RegistryImageKind.TEMPLATE,
    visibility: RegistryVisibility.PUBLIC,
    labels: ["node"],
    changesNotYetPublished: false,
  });
}

function makeImage() {
  return create(RegistryImageSchema, {
    id: "artifact-1",
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
    artifactId: "artifact-1",
    ownerWorkspaceId: "workspace-1",
    targetWorkspaceId: "target-workspace",
    currentSnapshotId: "snapshot-1",
    grantedViaTokenId: "token-1",
  });
}

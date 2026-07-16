import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { Client } from "@connectrpc/connect";

import { mapError } from "./errors.js";
import {
  BindPreviewUrlRequestSchema,
  CreatePreviewUrlRequestSchema,
  DeletePreviewUrlRequestSchema,
  GetPreviewUrlRequestSchema,
  ListPreviewUrlsRequestSchema,
  SandboxService,
  UnbindPreviewUrlRequestSchema,
  type PreviewUrl as ProtoPreviewUrl,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

export interface PreviewUrl {
  id: string;
  projectId: string;
  workspaceId: string;
  ownerId: string;
  slug: string;
  token: string;
  previewUrl: string;
  sessionId?: string;
  port?: number;
  createdAt?: Date;
  updatedAt?: Date;
  lastAccessedAt?: Date;
}

export function previewUrlFromProto(proto: ProtoPreviewUrl | undefined): PreviewUrl | undefined {
  if (!proto) return undefined;
  return {
    id: proto.id,
    projectId: proto.projectId,
    workspaceId: proto.workspaceId,
    ownerId: proto.ownerId,
    slug: proto.slug,
    token: proto.token,
    previewUrl: proto.previewUrl,
    sessionId: proto.sessionId || undefined,
    port: proto.port,
    createdAt: proto.createdAt ? timestampDate(proto.createdAt) : undefined,
    updatedAt: proto.updatedAt ? timestampDate(proto.updatedAt) : undefined,
    lastAccessedAt: proto.lastAccessedAt ? timestampDate(proto.lastAccessedAt) : undefined,
  };
}

export class PreviewUrlClient {
  constructor(private readonly rpcClient: Client<typeof SandboxService>) {}

  async create(projectId: string, slug: string, options?: { sessionId?: string; port?: number }): Promise<PreviewUrl> {
    try {
      const resp = await this.rpcClient.createPreviewUrl(
        create(CreatePreviewUrlRequestSchema, {
          projectId,
          slug,
          sessionId: options?.sessionId,
          port: options?.port,
        }),
      );
      return previewUrlFromProto(resp.previewUrl)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async delete(previewUrlId: string): Promise<void> {
    try {
      await this.rpcClient.deletePreviewUrl(create(DeletePreviewUrlRequestSchema, { previewUrlId }));
    } catch (err) {
      throw mapError(err);
    }
  }

  async bind(previewUrlId: string, sessionId: string, port: number): Promise<PreviewUrl> {
    try {
      const resp = await this.rpcClient.bindPreviewUrl(
        create(BindPreviewUrlRequestSchema, { previewUrlId, sessionId, port }),
      );
      return previewUrlFromProto(resp.previewUrl)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async unbind(previewUrlId: string): Promise<PreviewUrl> {
    try {
      const resp = await this.rpcClient.unbindPreviewUrl(create(UnbindPreviewUrlRequestSchema, { previewUrlId }));
      return previewUrlFromProto(resp.previewUrl)!;
    } catch (err) {
      throw mapError(err);
    }
  }

  async list(
    projectId: string,
    pageSize = 20,
    pageToken = "",
  ): Promise<{ previewUrls: PreviewUrl[]; nextPageToken: string }> {
    try {
      const resp = await this.rpcClient.listPreviewUrls(
        create(ListPreviewUrlsRequestSchema, { projectId, pageSize, pageToken }),
      );
      return {
        previewUrls: (resp.previewUrls ?? []).map((item) => previewUrlFromProto(item)!),
        nextPageToken: resp.nextPageToken,
      };
    } catch (err) {
      throw mapError(err);
    }
  }

  async get(previewUrlId: string): Promise<PreviewUrl> {
    try {
      const resp = await this.rpcClient.getPreviewUrl(
        create(GetPreviewUrlRequestSchema, { lookup: { case: "previewUrlId", value: previewUrlId } }),
      );
      return previewUrlFromProto(resp.previewUrl)!;
    } catch (err) {
      throw mapError(err);
    }
  }
}

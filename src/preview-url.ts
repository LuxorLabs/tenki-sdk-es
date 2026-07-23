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
import { advancePageToken, automaticPageSize } from "./pagination.js";

export interface PreviewUrl {
  id: string;
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

export interface PreviewUrlOptions {
  /** Explicit workspace scope for service-token callers. Workspace API keys infer this server-side. */
  workspaceId?: string;
  sessionId?: string;
  port?: number;
}

export interface PreviewUrlListOptions {
  /** Explicit workspace scope for service-token callers. Workspace API keys infer this server-side. */
  workspaceId?: string;
}

export function previewUrlFromProto(proto: ProtoPreviewUrl | undefined): PreviewUrl | undefined {
  if (!proto) return undefined;
  return {
    id: proto.id,
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

  async create(slug: string, options?: PreviewUrlOptions): Promise<PreviewUrl> {
    try {
      const resp = await this.rpcClient.createPreviewUrl(
        create(CreatePreviewUrlRequestSchema, {
          slug,
          workspaceId: options?.workspaceId,
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

  async list(options?: PreviewUrlListOptions): Promise<PreviewUrl[]> {
    try {
      const previewUrls: PreviewUrl[] = [];
      let pageToken = "";
      do {
        const resp = await this.rpcClient.listPreviewUrls(
          create(ListPreviewUrlsRequestSchema, {
            workspaceId: options?.workspaceId,
            pageSize: automaticPageSize(),
            pageToken,
          }),
        );
        previewUrls.push(...(resp.previewUrls ?? []).map((item) => previewUrlFromProto(item)!));
        pageToken = advancePageToken(pageToken, resp.nextPageToken);
      } while (pageToken);
      return previewUrls;
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

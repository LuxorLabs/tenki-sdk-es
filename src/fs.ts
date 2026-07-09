import { create } from "@bufbuild/protobuf";

import { FileNotFoundError, mapError } from "./errors.js";
import {
  ListRequestSchema,
  MkdirRequestSchema,
  ReadFileStreamRequestSchema,
  RemoveRequestSchema,
  SandboxSessionDataPlaneServiceListRequestSchema,
  SandboxSessionDataPlaneServiceMkdirRequestSchema,
  SandboxSessionDataPlaneServiceReadFileStreamRequestSchema,
  SandboxSessionDataPlaneServiceRemoveRequestSchema,
  SandboxSessionDataPlaneServiceStatRequestSchema,
  SandboxSessionDataPlaneServiceWriteFileStreamRequestSchema,
  StatRequestSchema,
  WriteFileStreamRequestSchema,
  type ListResponse,
  type ReadFileStreamResponse,
  type StatResponse,
  type WriteFileStreamRequest,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type { Session } from "./session.js";

export interface FileInfo {
  path: string;
  size: bigint;
  mode: number;
  isDir: boolean;
  modifiedUnixNs: bigint;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

export interface ReadStreamOptions {
  offset?: bigint | number;
  length?: bigint | number;
  chunkBytes?: number;
}

export interface WriteStreamOptions {
  mode?: number;
  truncate?: boolean;
  sync?: boolean;
}

export interface ListOptions {
  includeHidden?: boolean;
}

export async function readFileStream(
  session: Session,
  path: string,
  options?: ReadStreamOptions,
): Promise<ReadableStream<Uint8Array>> {
  const request = create(ReadFileStreamRequestSchema, {
    sessionId: session.id,
    path,
    offset: toBigInt(options?.offset),
    length: toBigInt(options?.length),
    chunkBytes: options?.chunkBytes ?? 0,
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const dataPlane = await session.requireDataPlane();
        const responses = unwrapReadFileStream(
          dataPlane.readFileStream(create(SandboxSessionDataPlaneServiceReadFileStreamRequestSchema, { request })),
        );
        for await (const frame of responses) {
          if (frame.data.byteLength > 0) controller.enqueue(frame.data);
          if (frame.eof) break;
        }
        controller.close();
      } catch (err) {
        controller.error(mapError(err));
      }
    },
  });
}

export async function writeFileStream(
  session: Session,
  path: string,
  data: ReadableStream<Uint8Array>,
  options?: WriteStreamOptions,
): Promise<void> {
  const outbound = new AsyncQueue<WriteFileStreamRequest>();
  outbound.push(
    create(WriteFileStreamRequestSchema, {
      payload: {
        case: "start",
        value: {
          sessionId: session.id,
          path,
          mode: options?.mode ?? 0o644,
          truncate: options?.truncate ?? true,
          sync: options?.sync ?? false,
        },
      },
    }),
  );

  const dataPlane = await session.requireDataPlane();
  const abort = new AbortController();
  const response = dataPlane.writeFileStream(wrapWriteFileStream(outbound), { signal: abort.signal });
  // Stop draining the source once the RPC rejects; also marks it handled (await below still observes it).
  let rpcRejected = false;
  response.catch(() => {
    rpcRejected = true;
  });
  const reader = data.getReader();
  try {
    for (;;) {
      if (rpcRejected) break; // server aborted early; stop buffering the source, let `await response` throw
      const next = await reader.read();
      if (next.done) break;
      outbound.push(create(WriteFileStreamRequestSchema, { payload: { case: "data", value: next.value } }));
    }
    outbound.close();
    await response;
  } catch (err) {
    abort.abort(); // cancel the RPC so the server sees an abort, not a clean half-close (SC-012)
    outbound.fail(err);
    throw mapError(err);
  } finally {
    reader.releaseLock();
  }
}

export async function stat(session: Session, path: string): Promise<FileInfo> {
  try {
    const request = create(StatRequestSchema, { sessionId: session.id, path });
    const dataPlane = await session.requireDataPlane();
    const resp: StatResponse = (
      await dataPlane.stat(create(SandboxSessionDataPlaneServiceStatRequestSchema, { request }))
    ).response!;
    if (!resp.exists) {
      throw new FileNotFoundError(`no such file or directory: ${path}`);
    }
    return {
      path,
      size: resp.size,
      mode: resp.mode,
      isDir: resp.isDir,
      modifiedUnixNs: resp.modifiedUnixNs,
      isSymlink: resp.isSymlink,
      symlinkTarget: resp.symlinkTarget || undefined,
    };
  } catch (err) {
    throw mapError(err);
  }
}

export async function mkdir(session: Session, path: string): Promise<void> {
  try {
    const request = create(MkdirRequestSchema, { sessionId: session.id, path, mode: 0o755, recursive: true });
    const dataPlane = await session.requireDataPlane();
    await dataPlane.mkdir(create(SandboxSessionDataPlaneServiceMkdirRequestSchema, { request }));
  } catch (err) {
    throw mapError(err);
  }
}

export async function remove(session: Session, path: string): Promise<void> {
  try {
    const request = create(RemoveRequestSchema, { sessionId: session.id, path, recursive: true });
    const dataPlane = await session.requireDataPlane();
    await dataPlane.remove(create(SandboxSessionDataPlaneServiceRemoveRequestSchema, { request }));
  } catch (err) {
    throw mapError(err);
  }
}

export async function list(session: Session, path: string, options?: ListOptions): Promise<FileInfo[]> {
  try {
    const request = create(ListRequestSchema, {
      sessionId: session.id,
      path,
      includeHidden: options?.includeHidden ?? false,
    });
    const dataPlane = await session.requireDataPlane();
    const resp: ListResponse = (
      await dataPlane.list(create(SandboxSessionDataPlaneServiceListRequestSchema, { request }))
    ).response!;
    return resp.entries.map((entry) => ({
      path: entry.name,
      size: entry.size,
      mode: entry.mode,
      isDir: entry.isDir,
      modifiedUnixNs: entry.modifiedUnixNs,
    }));
  } catch (err) {
    throw mapError(err);
  }
}

async function* unwrapReadFileStream(responses: AsyncIterable<{ response?: ReadFileStreamResponse }>) {
  for await (const response of responses) {
    if (response.response) yield response.response;
  }
}

async function* wrapWriteFileStream(outbound: AsyncIterable<WriteFileStreamRequest>) {
  for await (const frame of outbound) {
    yield create(SandboxSessionDataPlaneServiceWriteFileStreamRequestSchema, { frame });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;
  private error: unknown;

  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    this.done = true;
    for (const resolve of this.resolvers.splice(0)) resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    this.error = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (this.error) throw this.error; // fail() wakes blocked consumers via close(); surface the error, don't return clean
      if (next.done) return;
      yield next.value;
    }
  }
}

function toBigInt(value: bigint | number | undefined): bigint {
  if (value == null) return 0n;
  return typeof value === "bigint" ? value : BigInt(value);
}

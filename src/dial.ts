import { create } from "@bufbuild/protobuf";

import { CapabilityUnavailableError, PrimitiveTimeoutError } from "./errors.js";
import {
  DialClosed_Reason,
  DialRequestSchema,
  SandboxSessionDataPlaneServiceDialRequestSchema,
  type DialRequest,
  type DialResponse,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import type { Session } from "./session.js";

export interface DialOptions {
  connectTimeoutMs?: number;
}

export type DialStream = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

export async function dial(session: Session, unixSocketPath: string, options?: DialOptions): Promise<DialStream> {
  for (let attempt = 0; ; attempt++) {
    const outbound = new AsyncQueue<DialRequest>();
    outbound.push(
      create(DialRequestSchema, {
        payload: {
          case: "open",
          value: {
            sessionId: session.id,
            target: { case: "unixSocketPath", value: unixSocketPath },
            connectTimeoutMs: options?.connectTimeoutMs ?? 0,
          },
        },
      }),
    );

    const dataPlane = await session.requireDataPlane();
    const responses = unwrapDataPlaneDial(dataPlane.dial(wrapDataPlaneDial(outbound)));
    const responseIterator = responses[Symbol.asyncIterator]();
    let first: IteratorResult<DialResponse>;
    try {
      first = await responseIterator.next();
    } catch (err) {
      if (attempt === 0 && (await session.reauthOnUnauthenticated(err))) {
        outbound.close();
        continue;
      }
      throw err;
    }
    if (first.done) throw new Error("sandbox dial closed before open");
    if (first.value.payload.case === "closed") {
      const closed = first.value.payload.value;
      if (closed.reason === DialClosed_Reason.CAPABILITY_UNAVAILABLE) {
        if (closed.detail?.startsWith("first_frame_timeout")) {
          throw new PrimitiveTimeoutError("dial", closed.detail);
        }
        throw new CapabilityUnavailableError("dial", closed.detail || undefined);
      }
      throw new Error(closed.detail || `sandbox dial failed: ${DialClosed_Reason[closed.reason]}`);
    }
    if (first.value.payload.case !== "opened") throw new Error("sandbox dial did not open");

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        outbound.push(create(DialRequestSchema, { payload: { case: "data", value: chunk } }));
      },
      close() {
        outbound.push(create(DialRequestSchema, { payload: { case: "halfClose", value: true } }));
        outbound.close();
      },
      abort(reason) {
        outbound.fail(reason);
      },
    });

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (;;) {
            const next = await responseIterator.next();
            if (next.done) break;
            const frame = next.value;
            if (frame.payload.case === "data") controller.enqueue(frame.payload.value);
            if (frame.payload.case === "closed") {
              controller.close();
              return;
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        outbound.close();
      },
    });

    return { readable, writable };
  }
}

async function* wrapDataPlaneDial(outbound: AsyncIterable<DialRequest>) {
  for await (const frame of outbound) {
    yield create(SandboxSessionDataPlaneServiceDialRequestSchema, { frame });
  }
}

async function* unwrapDataPlaneDial(responses: AsyncIterable<{ frame?: DialResponse }>) {
  for await (const response of responses) {
    if (response.frame) yield response.frame;
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
      if (next.done) return;
      yield next.value;
    }
  }
}

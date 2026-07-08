import type { Output } from "./options.js";
import type { ExecResult } from "./result.js";

export class Stream {
  private queue: Output[] = [];
  private waiters: Array<{ resolve: (value: Output | null) => void; reject: (reason?: unknown) => void }> = [];
  private draining = false;
  private closed = false;
  private finalResult!: ExecResult;
  private finalError: unknown;
  private waitPromise: Promise<ExecResult>;
  private resolveWait!: (value: ExecResult) => void;
  private rejectWait!: (reason?: unknown) => void;

  constructor(private abortController: AbortController) {
    this.waitPromise = new Promise<ExecResult>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }

  next(): Promise<Output | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (this.closed) {
      return this.finalError ? Promise.reject(this.finalError) : Promise.resolve(null);
    }
    return new Promise<Output | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  wait(): Promise<ExecResult> {
    this.draining = true;
    this.queue = [];
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(null);
    }
    return this.waitPromise;
  }

  cancel(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  push(output: Output): void {
    if (this.draining) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(output);
      return;
    }
    this.queue.push(output);
  }

  finish(result: ExecResult): void {
    this.closed = true;
    this.finalResult = result;
    this.resolveWait(result);
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(null);
    }
  }

  fail(error: unknown): void {
    this.closed = true;
    this.finalError = error;
    this.rejectWait(error);
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

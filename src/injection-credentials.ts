import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";

import {
  CapabilityUnavailableError,
  FileTooLargeError,
  GitOperationFailedError,
  mapError,
  SandboxError,
  type TemplateRuntimeFailedError,
} from "./errors.js";
import { TemplateRuntimeFailureSchema } from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  SessionInjectionCredentialInputSchema,
  type SessionInjectionCredentialMetadata,
} from "./internal/proto/tenki/sandbox/v1/session_injection_credentials_pb.js";

export interface InjectionRule {
  origin: string;
  methods: string[];
  pathPrefix: string;
  header: string;
}

const values = new WeakMap<InjectionCredentialInput, Uint8Array>();
const inspect = Symbol.for("nodejs.util.inspect.custom");

export class InjectionCredentialInput {
  constructor(
    readonly name: string,
    value: Uint8Array,
    readonly rules: InjectionRule[],
  ) {
    values.set(this, Uint8Array.from(value));
    this.rules = rules.map((rule) => {
      const methods = [...rule.methods];
      Object.freeze(methods);
      return Object.freeze({ ...rule, methods });
    });
    Object.freeze(this.rules);
    Object.freeze(this);
  }
  toString(): string {
    return "InjectionCredentialInput([REDACTED])";
  }
  toJSON(): string {
    return this.toString();
  }
  [inspect](): string {
    return this.toString();
  }
}

export interface InjectionCredentialMetadata {
  credentialId: string;
  name: string;
  revision: number;
  revoked: boolean;
}

export function injectionInput(input: InjectionCredentialInput) {
  const value = values.get(input);
  if (!value) throw new TypeError("expected InjectionCredentialInput");
  return create(SessionInjectionCredentialInputSchema, {
    name: input.name,
    value: Uint8Array.from(value),
    rules: input.rules.map((rule) => ({ ...rule, methods: [...rule.methods] })),
  });
}

export function injectionMetadata(value?: SessionInjectionCredentialMetadata): InjectionCredentialMetadata {
  if (!value) throw new Error("missing injection credential metadata");
  return { credentialId: value.credentialId, name: value.name, revision: value.revision, revoked: value.revoked };
}

export function injectionRevision(value?: number): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
    throw new TypeError("expected revision must be a uint32");
  return value;
}

// Keep admission identity while discarding remote text and unrelated error details.
export function safeInjectionError(error: unknown): Error {
  const local = error instanceof ConnectError ? error.cause : error;
  if (local instanceof Error && (local.name === "AbortError" || local.name === "TimeoutError")) {
    return new DOMException("session injection credential operation cancelled", local.name);
  }
  const original = ConnectError.from(error);
  const failure = original.findDetails(TemplateRuntimeFailureSchema)[0];
  const details = failure
    ? [
        {
          desc: TemplateRuntimeFailureSchema,
          value: create(TemplateRuntimeFailureSchema, {
            session: failure.session
              ? {
                  id: failure.session.id,
                  state: failure.session.state,
                  runtimeState: failure.session.runtimeState,
                  egress: { publicEgress: failure.session.egress?.publicEgress },
                }
              : undefined,
            reason: "template runtime failed",
          }),
        },
      ]
    : [];
  const message = "session injection credential operation failed";
  const cause = new ConnectError(message, original.code, undefined, details);
  const mapped = mapError(error);
  if (mapped instanceof GitOperationFailedError)
    return new GitOperationFailedError(message, "", mapped.exitCode, mapped.retryable, { cause });
  if (mapped instanceof CapabilityUnavailableError)
    return new CapabilityUnavailableError(mapped.primitive, message, { cause });
  if (mapped instanceof FileTooLargeError)
    return new FileTooLargeError(message, mapped.operation, mapped.sizeBytes, mapped.maxBytes, { cause });
  const ErrorType = mapped.constructor as new (message: string, options?: ErrorOptions) => SandboxError;
  return new ErrorType(message, { cause });
}

// Credential admission adds metadata without changing existing error constructors.
declare module "./errors.js" {
  interface WaitReadyFailedError {
    credentials?: InjectionCredentialMetadata[];
    runtimeFailure?: TemplateRuntimeFailedError;
  }
  interface TemplateRuntimeFailedError {
    credentials?: InjectionCredentialMetadata[];
    runtimeFailure?: TemplateRuntimeFailedError;
  }
}

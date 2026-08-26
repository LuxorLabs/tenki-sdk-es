import {
  SandboxWarningCode as ProtoSandboxWarningCode,
  type SandboxWarning as ProtoSandboxWarning,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

type ProtoSandboxWarningCodeName = keyof typeof ProtoSandboxWarningCode;

export type SandboxWarningCode = ProtoSandboxWarningCodeName;

export const SandboxWarningCodes = Object.fromEntries(
  Object.keys(ProtoSandboxWarningCode)
    .filter((name): name is ProtoSandboxWarningCodeName => Number.isNaN(Number(name)))
    .map((name) => [name, name]),
) as { readonly [Code in SandboxWarningCode]: Code };

export interface SandboxWarning {
  code: SandboxWarningCode;
  message: string;
}

export type WarningHandler = (warning: SandboxWarning) => void;

export function defaultWarningHandler(warning: SandboxWarning): void {
  console.warn(`tenki sandbox warning [${warning.code}]: ${warning.message}`);
}

export function emitWarnings(handler: WarningHandler | undefined, warnings: readonly SandboxWarning[]): void {
  for (const warning of warnings) {
    try {
      handler?.(warning);
    } catch (warningHandlerError) {
      console.error("tenki sandbox warning handler failed", warningHandlerError);
    }
  }
}

export function sandboxWarningsFromProto(protoWarnings: readonly ProtoSandboxWarning[] | undefined): SandboxWarning[] {
  return (protoWarnings ?? []).map((warning) => ({
    code: sandboxWarningCodeFromProto(warning.code),
    message: warning.message,
  }));
}

function sandboxWarningCodeFromProto(code: ProtoSandboxWarningCode): SandboxWarningCode {
  const name = ProtoSandboxWarningCode[code];
  if (typeof name !== "string") {
    return SandboxWarningCodes.UNSPECIFIED;
  }
  return name as SandboxWarningCode;
}

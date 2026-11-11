import {
  SandboxWarningCode as ProtoSandboxWarningCode,
  type SandboxWarning as ProtoSandboxWarning,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";
import {
  TemplateWarningCode as ProtoTemplateWarningCode,
  type TemplateWarning as ProtoTemplateWarning,
} from "./internal/proto/tenki/sandbox/v1/template_pb.js";

type ProtoSandboxWarningCodeName = keyof typeof ProtoSandboxWarningCode;
type ProtoTemplateWarningCodeName = keyof typeof ProtoTemplateWarningCode;

// Template warning codes (e.g. SPEC_VERSION_DEPRECATED) share the sandbox warning shape.
export type SandboxWarningCode = ProtoSandboxWarningCodeName | ProtoTemplateWarningCodeName;

export const SandboxWarningCodes = Object.fromEntries(
  [...Object.keys(ProtoSandboxWarningCode), ...Object.keys(ProtoTemplateWarningCode)]
    .filter((name): name is SandboxWarningCode => Number.isNaN(Number(name)))
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

export function templateWarningsFromProto(
  protoWarnings: readonly ProtoTemplateWarning[] | undefined,
): SandboxWarning[] {
  return (protoWarnings ?? []).map((warning) => {
    const name = ProtoTemplateWarningCode[warning.code];
    return {
      code: typeof name === "string" ? (name as SandboxWarningCode) : SandboxWarningCodes.UNSPECIFIED,
      message: warning.message,
    };
  });
}

function sandboxWarningCodeFromProto(code: ProtoSandboxWarningCode): SandboxWarningCode {
  const name = ProtoSandboxWarningCode[code];
  if (typeof name !== "string") {
    return SandboxWarningCodes.UNSPECIFIED;
  }
  return name as SandboxWarningCode;
}

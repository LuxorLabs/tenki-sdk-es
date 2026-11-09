export const ENV_LUXORAI_AUTH_TOKEN = "LUXORAI_AUTH_TOKEN";
export const ENV_LUXORAI_API_KEY = "LUXORAI_API_KEY";
export const ENV_LUXORAI_API_ENDPOINT = "LUXORAI_API_ENDPOINT";
export const ENV_LUXORAI_API_URL = "LUXORAI_API_URL";
export const ENV_LUXORAI_GATEWAY_URL = "LUXORAI_SANDBOX_GATEWAY_URL";
export const ENV_LUXORAI_CLOUD_API_URL = "LUXORAI_CLOUD_API_URL";
export const ENV_LUXORAI_RUN_TRACE_TIMING = "LUXORAI_SDK_RUN_TRACE_TIMING";

export const ENV_AUTH_TOKEN = "TENKI_AUTH_TOKEN";
export const ENV_API_KEY = "TENKI_API_KEY";
export const ENV_API_ENDPOINT = "TENKI_API_ENDPOINT";
export const ENV_API_URL = "TENKI_API_URL";
export const ENV_GATEWAY_URL = "TENKI_SANDBOX_GATEWAY_URL";
export const ENV_CLOUD_API_URL = "TENKI_CLOUD_API_URL";
export const ENV_RUN_TRACE_TIMING = "TENKI_SDK_RUN_TRACE_TIMING";

// Precedence order: every LUXORAI_* name before its TENKI_* fallback.
export const AUTH_TOKEN_ENVS = [ENV_LUXORAI_AUTH_TOKEN, ENV_LUXORAI_API_KEY, ENV_AUTH_TOKEN, ENV_API_KEY] as const;
export const BASE_URL_ENVS = [ENV_LUXORAI_API_ENDPOINT, ENV_LUXORAI_API_URL, ENV_API_ENDPOINT, ENV_API_URL] as const;
export const GATEWAY_URL_ENVS = [ENV_LUXORAI_GATEWAY_URL, ENV_GATEWAY_URL] as const;
export const CLOUD_API_URL_ENVS = [ENV_LUXORAI_CLOUD_API_URL, ENV_CLOUD_API_URL] as const;
export const RUN_TRACE_TIMING_ENVS = [ENV_LUXORAI_RUN_TRACE_TIMING, ENV_RUN_TRACE_TIMING] as const;

export const API_KEY_PREFIXES = ["lx_", "tk_"] as const;

export const DEFAULT_BASE_URL = "https://api.tenki.cloud";

declare const __SDK_VERSION__: string | undefined;
export const SDK_VERSION = typeof __SDK_VERSION__ === "string" ? __SDK_VERSION__ : "unknown";
export const SDK_HEADER = "x-luxor-sdk";
export const SDK_HEADER_VALUE = `typescript/${SDK_VERSION}`;
export const SDK_USER_AGENT = `luxor-sandbox-typescript/${SDK_VERSION}`;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_DATA_PLANE_READY_TIMEOUT_MS = 60_000;

export const DEFAULT_SESSION_CREATE_TIMEOUT_MS = 3 * 60_000;
export const DEFAULT_TEMPLATE_SPEC_CREATE_TIMEOUT_MS = 2 * 60 * 60_000;
export const DEFAULT_SNAPSHOT_CREATE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_RESTORE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
export const DEFAULT_VOLUME_DETACH_TIMEOUT_MS = 2 * 60_000;

export const DEFAULT_CPU_CORES = 2;
export const DEFAULT_MEMORY_MB = 4096;
export const DEFAULT_DISK_SIZE_GB = 5;

export const POLL_INTERVAL_MS = 2_000;

// pollBackoffMs returns the delay before the next poll attempt.
// Starts at 100ms and ramps to a 2s steady state so fast operations
// (snapshot restore ~1.5s) are observed promptly without hammering
// the server on long-running ones.
export function pollBackoffMs(attempt: number): number {
  if (attempt <= 0) return 100;
  if (attempt === 1) return 250;
  if (attempt === 2) return 500;
  if (attempt === 3) return 1_000;
  return 2_000;
}

// Size helpers
export const Byte = 1;
export const KB = 1_000;
export const MB = 1_000_000;
export const GB = 1_000_000_000;
export const TB = 1_000_000_000_000;
export const KiB = 1_024;
export const MiB = 1_048_576;
export const GiB = 1_073_741_824;
export const TiB = 1_099_511_627_776;

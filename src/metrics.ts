import { timestampDate } from "@bufbuild/protobuf/wkt";

import type {
  GetSessionMetricsResponse,
  SessionCPUUsageAverage as ProtoSessionCPUUsageAverage,
  SessionMemoryUsageAverage as ProtoSessionMemoryUsageAverage,
} from "./internal/proto/tenki/sandbox/v1/sandbox_pb.js";

// Numeric durations use milliseconds, matching the TypeScript SDK's *Ms APIs.
export interface SessionCPUUsageAverage {
  averageCores?: number;
  averagePercent?: number;
  limitCores: number;
  sampleCount: number;
  observedDurationMs: number;
  coveragePercent: number;
  firstSampleAt?: Date;
  lastSampleAt?: Date;
}

export interface SessionMemoryUsageAverage {
  averageBytes?: number;
  averagePercent?: number;
  limitBytes: number;
  sampleCount: number;
  observedDurationMs: number;
  coveragePercent: number;
  firstSampleAt?: Date;
  lastSampleAt?: Date;
}

export interface SessionMetrics {
  sessionId: string;
  requestedWindowMs: number;
  windowStart?: Date;
  windowEnd?: Date;
  cpu: SessionCPUUsageAverage;
  memory: SessionMemoryUsageAverage;
}

export function sessionMetricsFromProto(metrics: GetSessionMetricsResponse): SessionMetrics {
  return {
    sessionId: metrics.sessionId,
    requestedWindowMs: durationMs(metrics.requestedWindow),
    windowStart: metrics.windowStart ? timestampDate(metrics.windowStart) : undefined,
    windowEnd: metrics.windowEnd ? timestampDate(metrics.windowEnd) : undefined,
    cpu: cpuUsageAverageFromProto(metrics.cpu),
    memory: memoryUsageAverageFromProto(metrics.memory),
  };
}

function cpuUsageAverageFromProto(usage?: ProtoSessionCPUUsageAverage): SessionCPUUsageAverage {
  return {
    averageCores: usage?.averageCores,
    averagePercent: usage?.averagePercent,
    limitCores: usage?.limitCores ?? 0,
    sampleCount: Number(usage?.sampleCount ?? 0n),
    observedDurationMs: durationMs(usage?.observedDuration),
    coveragePercent: usage?.coveragePercent ?? 0,
    firstSampleAt: usage?.firstSampleAt ? timestampDate(usage.firstSampleAt) : undefined,
    lastSampleAt: usage?.lastSampleAt ? timestampDate(usage.lastSampleAt) : undefined,
  };
}

function memoryUsageAverageFromProto(usage?: ProtoSessionMemoryUsageAverage): SessionMemoryUsageAverage {
  return {
    averageBytes: usage?.averageBytes,
    averagePercent: usage?.averagePercent,
    limitBytes: Number(usage?.limitBytes ?? 0n),
    sampleCount: Number(usage?.sampleCount ?? 0n),
    observedDurationMs: durationMs(usage?.observedDuration),
    coveragePercent: usage?.coveragePercent ?? 0,
    firstSampleAt: usage?.firstSampleAt ? timestampDate(usage.firstSampleAt) : undefined,
    lastSampleAt: usage?.lastSampleAt ? timestampDate(usage.lastSampleAt) : undefined,
  };
}

function durationMs(value?: { seconds: bigint; nanos: number }): number {
  return Number(value?.seconds ?? 0n) * 1_000 + (value?.nanos ?? 0) / 1_000_000;
}

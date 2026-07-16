import { InvalidResourceConfigError } from "./errors.js";

export const MIN_CPU_CORES = 1;
export const MAX_CPU_CORES = 16;
export const MIN_CREATE_MEMORY_MB = 128;
export const MIN_PROVISION_MEMORY_MB = 512;
export const MAX_MEMORY_MB = 65536;
export const MIN_DISK_SIZE_GB = 5;
export const MAX_DISK_SIZE_GB = 100;

interface ResourceOptions {
  cpuCores?: number;
  memoryMb?: number;
  diskSizeGb?: number;
}

export function validateCreateResources(resources: ResourceOptions): void {
  if (resources.cpuCores != null) validateCpuCores(resources.cpuCores);
  if (resources.memoryMb != null) validateMemoryMb(resources.memoryMb, MIN_CREATE_MEMORY_MB);
  if (resources.diskSizeGb != null) validateDiskSizeGb(resources.diskSizeGb);
}

export function validateTemplateResources(resources?: ResourceOptions): void {
  if (!resources) return;
  if (resources.cpuCores != null && resources.cpuCores !== 0) validateCpuCores(resources.cpuCores);
  if (resources.memoryMb != null && resources.memoryMb !== 0)
    validateMemoryMb(resources.memoryMb, MIN_PROVISION_MEMORY_MB);
  if (resources.diskSizeGb != null && resources.diskSizeGb !== 0) validateDiskSizeGb(resources.diskSizeGb);
}

function validateCpuCores(cpuCores: number): void {
  if (Number.isInteger(cpuCores) && cpuCores >= MIN_CPU_CORES && cpuCores <= MAX_CPU_CORES) return;
  throw new InvalidResourceConfigError(`cpuCores must be between ${MIN_CPU_CORES} and ${MAX_CPU_CORES}`);
}

function validateMemoryMb(memoryMb: number, minMemoryMb: number): void {
  if (!Number.isInteger(memoryMb) || memoryMb < minMemoryMb || memoryMb > MAX_MEMORY_MB) {
    throw new InvalidResourceConfigError(`memoryMb must be between ${minMemoryMb} and ${MAX_MEMORY_MB}`);
  }
  if (memoryMb % 2 !== 0) {
    throw new InvalidResourceConfigError("memoryMb must be aligned to 2 MiB");
  }
}

function validateDiskSizeGb(diskSizeGb: number): void {
  if (Number.isInteger(diskSizeGb) && diskSizeGb >= MIN_DISK_SIZE_GB && diskSizeGb <= MAX_DISK_SIZE_GB) return;
  throw new InvalidResourceConfigError(`diskSizeGb must be between ${MIN_DISK_SIZE_GB} and ${MAX_DISK_SIZE_GB}`);
}

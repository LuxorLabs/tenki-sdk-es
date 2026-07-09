export function dataPlaneReadyBackoffMs(attempt: number): number {
  return Math.min(50 * (attempt + 1), 750);
}

export async function sleepReadyBackoff(attempt: number, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(dataPlaneReadyBackoffMs(attempt), remaining)));
}

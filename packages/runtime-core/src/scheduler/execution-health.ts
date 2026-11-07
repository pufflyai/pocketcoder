export const PROJECTION_CAPACITY_WAIT_MS = 5 * 60_000;
export const EXECUTION_FAILURE_WAIT_MS = 5 * 60_000;

// One producer's outage does not make the whole controller unready.
export function executionUnhealthy(
  failures: Iterable<{ workspaceId: string; since: number }>,
  capacityWaits: Iterable<number>,
  now: number,
) {
  if ([...capacityWaits].some((since) => now - since > PROJECTION_CAPACITY_WAIT_MS)) return true;
  const workspaces = new Set(
    [...failures]
      .filter((failure) => now - failure.since >= EXECUTION_FAILURE_WAIT_MS)
      .map((failure) => failure.workspaceId),
  );
  return workspaces.size > 1;
}

export function producerMissing(
  observed: { exists: boolean; running: boolean; containerIdentity?: string },
  incarnationId: string,
) {
  return !observed.exists || !observed.running || observed.containerIdentity !== incarnationId;
}

import type { UsageSnapshot } from './usageTypes';

export function newestUsageSnapshot(
  current: UsageSnapshot | undefined,
  candidate: UsageSnapshot | undefined
): UsageSnapshot | undefined {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.observedAt > current.observedAt) {
    return candidate;
  }
  return current;
}

export function discardResetWindows(
  snapshot: UsageSnapshot,
  now = Date.now()
): UsageSnapshot {
  const windows = snapshot.windows.filter(
    (window) => window.resetsAt === undefined || window.resetsAt * 1000 > now
  );
  if (windows.length === snapshot.windows.length) {
    return snapshot;
  }
  return {
    ...snapshot,
    status: windows.length > 0 ? snapshot.status : 'waiting',
    windows,
    detail:
      windows.length > 0
        ? snapshot.detail
        : 'Waiting for Claude usage after the quota reset'
  };
}

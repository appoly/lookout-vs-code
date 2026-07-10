import type { UsageSnapshot, UsageWindow } from './usageTypes';

export function formatResetDescription(
  resetsAtSeconds: number | undefined,
  nowMilliseconds = Date.now()
): string {
  if (!resetsAtSeconds) {
    return '';
  }
  const delta = resetsAtSeconds * 1000 - nowMilliseconds;
  if (delta <= 0) {
    return 'reset due';
  }
  let minutes = Math.ceil(delta / 60_000);
  const days = Math.floor(minutes / 1_440);
  minutes %= 1_440;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }
  return `resets in ${parts.join(' ')}`;
}

/**
 * Returns the quota window shown in the compact status bar.
 * Claude's short rolling window is the actionable limit, while other providers
 * continue to show their most-used window.
 */
export function selectStatusWindow(
  snapshot: UsageSnapshot
): UsageWindow | undefined {
  if (snapshot.provider === 'claude') {
    const fiveHour = snapshot.windows.find((window) => window.id === 'five_hour');
    if (fiveHour) {
      return fiveHour;
    }
  }
  return [...snapshot.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
}

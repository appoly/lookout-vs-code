import type { UsageWindow } from './usageTypes';

export function normalizeClaudeUsage(value: unknown): UsageWindow[] {
  if (!isRecord(value) || !isRecord(value.rate_limits)) {
    return [];
  }
  return [
    normalizeWindow(
      'five_hour',
      '5 hour',
      300,
      value.rate_limits.five_hour
    ),
    normalizeWindow(
      'seven_day',
      '7 day',
      10_080,
      value.rate_limits.seven_day
    )
  ].filter((window): window is UsageWindow => window !== undefined);
}

export function formatClaudeUsage(windows: readonly UsageWindow[]): string {
  if (windows.length === 0) {
    return 'Claude · usage waiting for first response';
  }
  return `Claude · ${windows
    .map((window) => `${window.label} ${Math.round(window.usedPercent)}%`)
    .join(' · ')}`;
}

function normalizeWindow(
  id: string,
  label: string,
  windowMinutes: number,
  value: unknown
): UsageWindow | undefined {
  if (!isRecord(value) || typeof value.used_percentage !== 'number') {
    return undefined;
  }
  return {
    id,
    label,
    usedPercent: Math.max(0, Math.min(100, value.used_percentage)),
    windowMinutes,
    ...(typeof value.resets_at === 'number'
      ? { resetsAt: value.resets_at }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

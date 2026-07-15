import type { UsageWindow } from './usageTypes';
import type {
  DelegatedAgentTokenUsage,
  SessionTokenUsage
} from './types';

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

export function normalizeClaudeSessionTokenUsage(
  value: unknown,
  observedAt = Date.now()
): SessionTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const context = isRecord(value.context_window)
    ? value.context_window
    : undefined;
  const current = isRecord(context?.current_usage)
    ? context.current_usage
    : undefined;
  const inputTokens =
    finiteNumber(context?.total_input_tokens) ??
    sumDefined([
      finiteNumber(current?.input_tokens),
      finiteNumber(current?.cache_creation_input_tokens),
      finiteNumber(current?.cache_read_input_tokens)
    ]);
  const outputTokens =
    finiteNumber(context?.total_output_tokens) ??
    finiteNumber(current?.output_tokens);
  const delegatedAgents = normalizeClaudeDelegatedAgentTokenUsage(value);
  const cost = isRecord(value.cost) ? value.cost : undefined;
  const totalCostUsd = finiteNumber(cost?.total_cost_usd);
  const contextWindowTokens = finiteNumber(context?.context_window_size);
  const contextUsedPercent = finiteNumber(context?.used_percentage);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalCostUsd === undefined &&
    delegatedAgents.length === 0
  ) {
    return undefined;
  }

  const safeInput = nonNegativeInteger(inputTokens ?? 0);
  const safeOutput = nonNegativeInteger(outputTokens ?? 0);
  return {
    source: 'claude-statusline',
    observedAt,
    contextTokens: safeInput + safeOutput,
    inputTokens: safeInput,
    outputTokens: safeOutput,
    ...(contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: nonNegativeInteger(contextWindowTokens) }),
    ...(contextUsedPercent === undefined
      ? {}
      : { contextUsedPercent: Math.max(0, Math.min(100, contextUsedPercent)) }),
    ...(totalCostUsd === undefined
      ? {}
      : { totalCostUsd: Math.max(0, totalCostUsd) }),
    delegatedAgents
  };
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  return values.some((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(value));
}

export function normalizeClaudeDelegatedAgentTokenUsage(
  value: unknown
): DelegatedAgentTokenUsage[] {
  if (!isRecord(value)) {
    return [];
  }
  const tasks = value.tasks;
  if (!Array.isArray(tasks)) {
    return [];
  }
  return tasks
    .slice(0, 64)
    .flatMap((candidate): DelegatedAgentTokenUsage[] => {
      if (!isRecord(candidate)) {
        return [];
      }
      const id = boundedString(candidate.id, 200);
      const tokenCount = finiteNumber(candidate.tokenCount);
      if (!id || tokenCount === undefined) {
        return [];
      }
      return [{
        id,
        label:
          boundedString(candidate.name, 120) ||
          boundedString(candidate.label, 120) ||
          'Delegated agent',
        tokenCount: nonNegativeInteger(tokenCount),
        ...(boundedString(candidate.status, 40)
          ? { status: boundedString(candidate.status, 40) }
          : {})
      }];
    })
    .sort((left, right) => right.tokenCount - left.tokenCount);
}

function boundedString(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

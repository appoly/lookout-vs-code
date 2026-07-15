import type {
  AgentSession,
  DelegatedAgentTokenUsage,
  SessionTokenUsage
} from './types';

export type TokenUsageSeverity = 'normal' | 'warning' | 'critical';

interface ObservedDelegatedUsage {
  readonly observedAt: number;
  readonly delegatedAgents: readonly DelegatedAgentTokenUsage[];
}

export function latestDelegatedTokenUsage(
  snapshot: ObservedDelegatedUsage,
  previous: ObservedDelegatedUsage,
  pending?: ObservedDelegatedUsage
): ObservedDelegatedUsage {
  let latest = previous;
  if (pending && pending.observedAt > latest.observedAt) {
    latest = pending;
  }
  // An empty account snapshot means that this status-line payload did not
  // carry task data; only a dedicated delegated-agent event may clear tasks.
  if (
    snapshot.delegatedAgents.length > 0 &&
    snapshot.observedAt > latest.observedAt
  ) {
    latest = snapshot;
  }
  return latest;
}

export function formatTokenCount(value: number): string {
  const count = Math.max(0, Math.floor(value));
  if (count < 1_000) {
    return String(count);
  }
  if (count < 1_000_000) {
    const thousands = count / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const millions = count / 1_000_000;
  return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}m`;
}

export function tokenUsageSeverity(
  session: AgentSession,
  warningPercent = 80,
  criticalPercent = 95
): TokenUsageSeverity {
  const percent = effectiveUsagePercent(session);
  if (percent === undefined) {
    return 'normal';
  }
  if (percent >= criticalPercent) {
    return 'critical';
  }
  return percent >= warningPercent ? 'warning' : 'normal';
}

export function sessionTokenSummary(session: AgentSession): string | undefined {
  const usage = session.tokenUsage;
  const budget = session.tokenBudget;
  if (usage && budget?.kind === 'claude-context-warning') {
    return `${formatTokenCount(usage.contextTokens)}/${formatTokenCount(
      budget.limitTokens
    )} ctx`;
  }
  if (usage) {
    return usage.contextUsedPercent === undefined
      ? `${formatTokenCount(usage.contextTokens)} ctx`
      : `${Math.round(usage.contextUsedPercent)}% ctx`;
  }
  if (budget?.kind === 'codex-rollout') {
    return `${formatTokenCount(budget.limitTokens)} budget`;
  }
  if (budget?.kind === 'claude-context-warning') {
    return `${formatTokenCount(budget.limitTokens)} ctx alert`;
  }
  return undefined;
}

export function sessionTokenDetailLines(session: AgentSession): readonly string[] {
  const lines: string[] = [];
  const usage = session.tokenUsage;
  if (usage) {
    lines.push(
      `Current context: ${formatTokenCount(usage.contextTokens)} tokens`,
      `Input/cache: ${formatTokenCount(usage.inputTokens)} tokens`,
      `Latest output: ${formatTokenCount(usage.outputTokens)} tokens`
    );
    if (usage.contextWindowTokens !== undefined) {
      lines.push(
        `Context window: ${formatTokenCount(usage.contextWindowTokens)} tokens${
          usage.contextUsedPercent === undefined
            ? ''
            : ` (${usage.contextUsedPercent.toFixed(1)}% used)`
        }`
      );
    }
    if (usage.totalCostUsd !== undefined) {
      lines.push(`Estimated session cost: $${usage.totalCostUsd.toFixed(2)}`);
    }
    lines.push(`Token data checked: ${new Date(usage.observedAt).toLocaleString()}`);
    for (const delegated of usage.delegatedAgents.slice(0, 8)) {
      lines.push(
        `Delegated · ${delegated.label}: ${formatTokenCount(
          delegated.tokenCount
        )} tokens${delegated.status ? ` · ${delegated.status}` : ''}`
      );
    }
  }
  if (session.tokenBudget?.kind === 'codex-rollout') {
    lines.push(
      `Codex rollout token budget: ${formatTokenCount(
        session.tokenBudget.limitTokens
      )} tokens (provider-managed)`
    );
  }
  if (session.tokenBudget?.kind === 'claude-context-warning') {
    lines.push(
      `Claude context alert: ${formatTokenCount(
        session.tokenBudget.limitTokens
      )} tokens (warning only)`
    );
  }
  return lines;
}

function effectiveUsagePercent(session: AgentSession): number | undefined {
  const usage: SessionTokenUsage | undefined = session.tokenUsage;
  if (
    usage &&
    session.tokenBudget?.kind === 'claude-context-warning' &&
    session.tokenBudget.limitTokens > 0
  ) {
    return (usage.contextTokens / session.tokenBudget.limitTokens) * 100;
  }
  return usage?.contextUsedPercent;
}

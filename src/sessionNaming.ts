import * as path from 'node:path';
import type { AgentKind } from './types';

export interface SessionNameContext {
  readonly kind: AgentKind;
  readonly cwd: string;
  readonly branch?: string;
  readonly existingLabels: readonly string[];
}

const MAX_CONTEXT_LENGTH = 60;

/**
 * Builds a launch label from facts Lookout already holds — provider kind, Git
 * branch, and working folder. Never from prompts or terminal output (D3).
 */
export function inferSessionLabel(context: SessionNameContext): string {
  const base = `${providerDisplayName(context.kind)} · ${sessionContextName(context)}`;
  const taken = new Set(context.existingLabels);
  if (!taken.has(base)) {
    return base;
  }
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${base} ${ordinal}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export function providerDisplayName(kind: AgentKind): string {
  switch (kind) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'custom':
      return 'Custom';
  }
}

function sessionContextName(context: SessionNameContext): string {
  // `git rev-parse --abbrev-ref HEAD` reports a detached checkout as 'HEAD',
  // which names nothing; fall back to the working folder.
  const branch = context.branch?.trim();
  const name =
    branch && branch !== 'HEAD'
      ? branch
      : path.basename(context.cwd.replace(/[\\/]+$/, '')) || 'agent';
  return name.length > MAX_CONTEXT_LENGTH
    ? `${name.slice(0, MAX_CONTEXT_LENGTH - 1)}…`
    : name;
}

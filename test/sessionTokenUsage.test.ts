import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../src/sessionModel';
import {
  formatTokenCount,
  latestDelegatedTokenUsage,
  sessionTokenSummary,
  tokenUsageSeverity
} from '../src/sessionTokenUsage';

test('formats compact token counts', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_250), '1.3k');
  assert.equal(formatTokenCount(125_000), '125k');
  assert.equal(formatTokenCount(1_250_000), '1.3m');
});

test('summarizes and grades a Claude context warning', () => {
  const session = {
    ...createSession('claude', 'Claude', 'claude', '/repo', 1, 'claude-1'),
    tokenBudget: {
      kind: 'claude-context-warning' as const,
      limitTokens: 100_000
    },
    tokenUsage: {
      source: 'claude-statusline' as const,
      observedAt: 2,
      contextTokens: 96_000,
      inputTokens: 95_000,
      outputTokens: 1_000,
      delegatedAgents: []
    }
  };
  assert.equal(sessionTokenSummary(session), '96k/100k ctx');
  assert.equal(tokenUsageSeverity(session, 80, 95), 'critical');
});

test('shows configured Codex budgets before usage is available', () => {
  const session = {
    ...createSession('codex', 'Codex', 'codex', '/repo', 1, 'codex-1'),
    tokenBudget: { kind: 'codex-rollout' as const, limitTokens: 50_000 }
  };
  assert.equal(sessionTokenSummary(session), '50k budget');
  assert.equal(tokenUsageSeverity(session), 'normal');
});

test('keeps newer delegated usage when account snapshots arrive out of order', () => {
  const newer = {
    observedAt: 200,
    delegatedAgents: [{ id: 'new', label: 'New', tokenCount: 2_000 }]
  };
  assert.strictEqual(
    latestDelegatedTokenUsage(
      {
        observedAt: 100,
        delegatedAgents: [{ id: 'old', label: 'Old', tokenCount: 1_000 }]
      },
      newer
    ),
    newer
  );
});

test('does not treat an empty account snapshot as delegated-agent completion', () => {
  const delegated = {
    observedAt: 100,
    delegatedAgents: [{ id: 'live', label: 'Live', tokenCount: 1_000 }]
  };
  assert.strictEqual(
    latestDelegatedTokenUsage(
      { observedAt: 200, delegatedAgents: [] },
      delegated
    ),
    delegated
  );
});

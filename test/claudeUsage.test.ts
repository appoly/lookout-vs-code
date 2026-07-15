import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatClaudeUsage,
  normalizeClaudeSessionTokenUsage,
  normalizeClaudeUsage
} from '../src/claudeUsage';

test('normalizes documented Claude status-line rate limits', () => {
  const windows = normalizeClaudeUsage({
    rate_limits: {
      five_hour: { used_percentage: 24.7, resets_at: 1_800_000_000 },
      seven_day: { used_percentage: -4 }
    }
  });
  assert.deepEqual(windows, [
    {
      id: 'five_hour',
      label: '5 hour',
      usedPercent: 24.7,
      resetsAt: 1_800_000_000,
      windowMinutes: 300
    },
    {
      id: 'seven_day',
      label: '7 day',
      usedPercent: 0,
      windowMinutes: 10_080
    }
  ]);
  assert.equal(formatClaudeUsage(windows), 'Claude · 5 hour 25% · 7 day 0%');
});

test('keeps unavailable Claude quota distinct from zero', () => {
  assert.deepEqual(normalizeClaudeUsage({}), []);
  assert.equal(
    formatClaudeUsage([]),
    'Claude · usage waiting for first response'
  );
});

test('normalizes live Claude context, cost, and delegated token counts', () => {
  assert.deepEqual(
    normalizeClaudeSessionTokenUsage(
      {
        context_window: {
          total_input_tokens: 20_000,
          total_output_tokens: 1_500,
          context_window_size: 200_000,
          used_percentage: 10.25
        },
        cost: { total_cost_usd: 1.234 },
        tasks: [
          { id: 'small', name: 'Explore', tokenCount: 200, status: 'running' },
          { id: 'large', label: 'Reviewer', tokenCount: 5_200 }
        ]
      },
      123
    ),
    {
      source: 'claude-statusline',
      observedAt: 123,
      contextTokens: 21_500,
      inputTokens: 20_000,
      outputTokens: 1_500,
      contextWindowTokens: 200_000,
      contextUsedPercent: 10.25,
      totalCostUsd: 1.234,
      delegatedAgents: [
        { id: 'large', label: 'Reviewer', tokenCount: 5_200 },
        {
          id: 'small',
          label: 'Explore',
          tokenCount: 200,
          status: 'running'
        }
      ]
    }
  );
});

test('derives Claude input tokens from documented current-usage components', () => {
  const usage = normalizeClaudeSessionTokenUsage({
    context_window: {
      current_usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        output_tokens: 40
      }
    }
  });
  assert.equal(usage?.inputTokens, 600);
  assert.equal(usage?.outputTokens, 40);
  assert.equal(usage?.contextTokens, 640);
});

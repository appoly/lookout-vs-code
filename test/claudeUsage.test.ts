import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClaudeUsage, normalizeClaudeUsage } from '../src/claudeUsage';

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

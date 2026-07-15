import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discardResetWindows,
  newestUsageSnapshot
} from '../src/usageFreshness';
import type { UsageSnapshot } from '../src/usageTypes';

test('keeps the newest usage observation across extension windows', () => {
  const old = claudeSnapshot(100, 100, 1_000);
  const current = claudeSnapshot(200, 10, 2_000);

  assert.equal(newestUsageSnapshot(old, current), current);
  assert.equal(newestUsageSnapshot(current, old), current);
});

test('does not present usage from a quota window after it resets', () => {
  const expired = claudeSnapshot(100, 100, 1_000);
  const result = discardResetWindows(expired, 1_001_000);

  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.windows, []);
  assert.equal(result.detail, 'Waiting for Claude usage after the quota reset');
});

test('retains quota windows whose reset is still in the future', () => {
  const current = claudeSnapshot(100, 10, 2_000);
  assert.equal(discardResetWindows(current, 1_000_000), current);
});

function claudeSnapshot(
  observedAt: number,
  usedPercent: number,
  resetsAt: number
): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'available',
    observedAt,
    source: 'claude-statusline',
    windows: [
      {
        id: 'five_hour',
        label: '5 hour',
        usedPercent,
        resetsAt
      }
    ]
  };
}

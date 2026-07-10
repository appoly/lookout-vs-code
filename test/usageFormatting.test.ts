import assert from 'node:assert/strict';
import test from 'node:test';
import { formatResetDescription, selectStatusWindow } from '../src/usageFormatting';

test('formats long reset countdowns as days, hours, and minutes', () => {
  const now = 1_800_000_000_000;
  const reset = now / 1000 + 167 * 60 * 60 + 51 * 60;
  assert.equal(
    formatResetDescription(reset, now),
    'resets in 6d 23h 51m'
  );
});

test('formats short and elapsed reset countdowns', () => {
  const now = 1_800_000_000_000;
  assert.equal(
    formatResetDescription(now / 1000 + 90 * 60, now),
    'resets in 1h 30m'
  );
  assert.equal(formatResetDescription(now / 1000 - 1, now), 'reset due');
  assert.equal(formatResetDescription(undefined, now), '');
});

test('uses Claude five-hour usage in the compact status summary', () => {
  const window = selectStatusWindow({
    provider: 'claude',
    status: 'available',
    observedAt: 0,
    source: 'claude-statusline',
    windows: [
      { id: 'five_hour', label: '5 hour', usedPercent: 3 },
      { id: 'seven_day', label: '7 day', usedPercent: 46 }
    ]
  });

  assert.equal(window?.usedPercent, 3);
});

test('uses Codex primary usage in the compact status summary', () => {
  const window = selectStatusWindow({
    provider: 'codex',
    status: 'available',
    observedAt: 0,
    source: 'codex-app-server',
    windows: [
      { id: 'codex:primary', label: '5 hour', usedPercent: 3 },
      { id: 'codex:secondary', label: '1 week', usedPercent: 46 }
    ]
  });

  assert.equal(window?.usedPercent, 3);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexErrorSnapshot,
  normalizeRateLimits
} from '../src/codexUsageProvider';

test('normalizes Codex rate-limit buckets and clamps percentages', () => {
  const snapshot = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'pro',
        primary: {
          usedPercent: 120,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000
        },
        secondary: {
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: 1_800_600_000
        },
        credits: { balance: '5.00', unlimited: false }
      }
    },
    rateLimitResetCredits: { availableCount: 2 }
  });

  assert.equal(snapshot.status, 'available');
  assert.equal(snapshot.plan, 'pro');
  assert.deepEqual(
    snapshot.windows.map(({ label, usedPercent }) => [label, usedPercent]),
    [
      ['5 hour', 100],
      ['1 week', 12]
    ]
  );
  assert.deepEqual(snapshot.credits, {
    balance: '5.00',
    unlimited: false,
    resetCount: 2
  });
});

test('maps signed-out Codex responses to authentication required', () => {
  const snapshot = codexErrorSnapshot(
    new Error('account/rateLimits/read: not logged in')
  );
  assert.equal(snapshot.status, 'authRequired');
  assert.deepEqual(snapshot.windows, []);
});

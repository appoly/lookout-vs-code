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

test('hides Codex Spark buckets by default and supports opt-in', () => {
  const payload = {
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 20, windowDurationMins: 300 }
      },
      codex_spark: {
        limitId: 'codex_spark',
        limitName: 'GPT-5.3-Codex-Spark',
        primary: { usedPercent: 80, windowDurationMins: 300 }
      }
    }
  };

  assert.deepEqual(
    normalizeRateLimits(payload).windows.map((window) => window.id),
    ['codex:primary']
  );
  assert.deepEqual(
    normalizeRateLimits(payload, { includeSparkLimits: true }).windows.map(
      (window) => window.id
    ),
    ['codex:primary', 'codex_spark:primary']
  );
});

test('keeps unrecognized rate-limit payloads distinct from sign-in state', () => {
  for (const payload of [null, undefined, {}]) {
    const snapshot = normalizeRateLimits(payload);
    assert.equal(snapshot.status, 'unsupported');
    assert.deepEqual(snapshot.windows, []);
    assert.equal(snapshot.detail, 'Codex did not report usage limits');
  }
});

test('normalizes credits-only payloads without rate-limit windows', () => {
  const snapshot = normalizeRateLimits({
    rateLimitResetCredits: { availableCount: 3 }
  });
  assert.equal(snapshot.status, 'available');
  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(snapshot.credits, { resetCount: 3 });
  assert.equal(snapshot.detail, 'No rate-limit windows reported');

  const emptyBuckets = normalizeRateLimits({
    rateLimitsByLimitId: {},
    rateLimitResetCredits: { availableCount: 1 }
  });
  assert.equal(emptyBuckets.status, 'available');
  assert.deepEqual(emptyBuckets.credits, { resetCount: 1 });
});

test('maps a missing rate-limit RPC method to unsupported', () => {
  const snapshot = codexErrorSnapshot(new Error('Method not found'));
  assert.equal(snapshot.status, 'unsupported');
  assert.equal(
    snapshot.detail,
    'This Codex CLI version does not report usage limits'
  );
});

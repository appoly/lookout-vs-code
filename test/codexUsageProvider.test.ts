import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  CodexUsageProvider,
  codexErrorSnapshot,
  normalizeRateLimits
} from '../src/codexUsageProvider';
import type { UsageSnapshot } from '../src/usageTypes';

interface FakeCodexChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: PassThrough;
  readonly requests: Array<{ readonly id?: number; readonly method?: string }>;
  readonly killed: boolean;
}

function createFakeCodexChild(respondToRequests = true): FakeCodexChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: Array<{ readonly id?: number; readonly method?: string }> = [];
  const emitter = new EventEmitter();
  let killed = false;
  let exitCode: number | null = null;
  const stdin = new Writable({
    decodeStrings: false,
    write(
      chunk: unknown,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ): void {
      const message = JSON.parse(String(chunk).trim()) as {
        readonly id?: number;
        readonly method?: string;
      };
      requests.push(message);
      if (respondToRequests && message.id !== undefined) {
        const result =
          message.method === 'account/rateLimits/read'
            ? {
                rateLimits: {
                  limitId: 'codex',
                  primary: {
                    usedPercent: 25,
                    windowDurationMins: 300
                  }
                }
              }
            : {};
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        });
      }
      callback();
    }
  });
  Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    kill: (): boolean => {
      killed = true;
      exitCode = 0;
      return true;
    }
  });
  Object.defineProperty(emitter, 'exitCode', {
    get: (): number | null => exitCode
  });
  return {
    child: emitter as unknown as ChildProcessWithoutNullStreams,
    stdout,
    requests,
    get killed(): boolean {
      return killed;
    }
  };
}

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

test('shares one startup across concurrent start and refresh calls', async () => {
  let resolveExecutable: ((value: string | undefined) => void) | undefined;
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  const resolvedExecutable = new Promise<string | undefined>((resolve) => {
    resolveExecutable = resolve;
  });
  const fake = createFakeCodexChild();
  let resolutionCount = 0;
  let spawnCount = 0;
  const provider = new CodexUsageProvider(
    'codex',
    () => undefined,
    false,
    undefined,
    {
      resolveLaunchTarget: async (): Promise<{
        command: string;
        args: string[];
        viaCmdWrapper: boolean;
      }> => {
        resolutionCount += 1;
        markResolutionStarted?.();
        return {
          command: (await resolvedExecutable) ?? 'codex-test.exe',
          args: ['app-server', '--stdio'],
          viaCmdWrapper: false
        };
      },
      spawnAppServer: (): ChildProcessWithoutNullStreams => {
        spawnCount += 1;
        return fake.child;
      }
    }
  );

  const first = provider.start();
  await resolutionStarted;
  const second = provider.start();
  const refresh = provider.refresh();

  assert.strictEqual(second, first);
  assert.equal(spawnCount, 0);
  resolveExecutable?.('codex-test.exe');
  await Promise.all([first, second, refresh]);

  assert.equal(resolutionCount, 1);
  assert.equal(spawnCount, 1);
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['initialize', 'initialized', 'account/rateLimits/read']
  );
  provider.dispose();
});

test('dispose during executable resolution prevents a late spawn', async () => {
  let resolveExecutable: ((value: string | undefined) => void) | undefined;
  let markResolutionStarted: (() => void) | undefined;
  const resolutionStarted = new Promise<void>((resolve) => {
    markResolutionStarted = resolve;
  });
  const resolvedExecutable = new Promise<string | undefined>((resolve) => {
    resolveExecutable = resolve;
  });
  const snapshots: UsageSnapshot[] = [];
  let spawnCount = 0;
  const provider = new CodexUsageProvider(
    'codex',
    (snapshot) => snapshots.push(snapshot),
    false,
    undefined,
    {
      resolveLaunchTarget: async (): Promise<{
        command: string;
        args: string[];
        viaCmdWrapper: boolean;
      }> => {
        markResolutionStarted?.();
        return {
          command: (await resolvedExecutable) ?? 'codex-test.exe',
          args: ['app-server', '--stdio'],
          viaCmdWrapper: false
        };
      },
      spawnAppServer: (): ChildProcessWithoutNullStreams => {
        spawnCount += 1;
        return createFakeCodexChild().child;
      }
    }
  );

  const starting = provider.start();
  await resolutionStarted;
  provider.dispose();
  resolveExecutable?.('codex-test.exe');
  await starting;

  assert.equal(spawnCount, 0);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.status),
    ['waiting']
  );
});

test('dispose during initialization terminates the active child', async () => {
  const fake = createFakeCodexChild(false);
  let markSpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const provider = new CodexUsageProvider(
    'codex',
    () => undefined,
    false,
    undefined,
    {
      resolveLaunchTarget: async (): Promise<{
        command: string;
        args: string[];
        viaCmdWrapper: boolean;
      }> => ({
        command: 'codex-test.exe',
        args: ['app-server', '--stdio'],
        viaCmdWrapper: false
      }),
      spawnAppServer: (): ChildProcessWithoutNullStreams => {
        markSpawned?.();
        return fake.child;
      }
    }
  );

  const starting = provider.start();
  await spawned;
  provider.dispose();
  await starting;

  assert.equal(fake.killed, true);
});

test('terminates a child created by a startup that becomes stale', async () => {
  const fake = createFakeCodexChild(false);
  const provider = new CodexUsageProvider(
    'codex',
    () => undefined,
    false,
    undefined,
    {
      resolveLaunchTarget: async (): Promise<{
        command: string;
        args: string[];
        viaCmdWrapper: boolean;
      }> => ({
        command: 'codex-test.exe',
        args: ['app-server', '--stdio'],
        viaCmdWrapper: false
      }),
      spawnAppServer: (): ChildProcessWithoutNullStreams => {
        provider.dispose();
        return fake.child;
      }
    }
  );

  await provider.start();

  assert.equal(fake.killed, true);
  assert.deepEqual(fake.requests, []);
});

test('terminates a provider that exceeds the stdout line limit', async () => {
  const fake = createFakeCodexChild(false);
  const snapshots: UsageSnapshot[] = [];
  let markSpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const provider = new CodexUsageProvider(
    'codex',
    (snapshot) => snapshots.push(snapshot),
    false,
    undefined,
    {
      resolveLaunchTarget: async (): Promise<{
        command: string;
        args: string[];
        viaCmdWrapper: boolean;
      }> => ({
        command: 'codex-test.exe',
        args: ['app-server', '--stdio'],
        viaCmdWrapper: false
      }),
      spawnAppServer: (): ChildProcessWithoutNullStreams => {
        markSpawned?.();
        return fake.child;
      }
    }
  );

  const starting = provider.start();
  await spawned;
  fake.stdout.write('x'.repeat(1024 * 1024 + 1));
  await starting;

  assert.equal(fake.killed, true);
  assert.equal(snapshots.at(-1)?.status, 'error');
  assert.match(snapshots.at(-1)?.detail ?? '', /size limit/i);
  provider.dispose();
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SharedFileStore } from '../src/sharedFileStore';

interface CounterStore {
  readonly count: number;
}

test('serializes concurrent cross-instance updates without lost writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-shared-store-'));
  const first = store(directory);
  const second = store(directory);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).update((current) => ({
        count: current.count + 1
      }))
    )
  );
  assert.equal((await first.read()).count, 20);
  const disk = JSON.parse(
    await readFile(path.join(directory, 'counter.json'), 'utf8')
  ) as CounterStore;
  assert.equal(disk.count, 20);
});

test('recovers from malformed metadata without executing or preserving it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-shared-store-'));
  await writeFile(path.join(directory, 'counter.json'), '{not json', 'utf8');
  assert.deepEqual(await store(directory).read(), { count: 0 });
});

test('default lock deadline allows a newly orphaned lock to become stale', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-shared-store-'));
  const lockPath = path.join(directory, 'counter.json.lock');
  const lockCreatedAt = Date.now();
  await writeFile(lockPath, '{}\n', 'utf8');
  await utimes(lockPath, lockCreatedAt / 1_000, lockCreatedAt / 1_000);

  let currentTime = lockCreatedAt;
  const shared = store(directory, {
    now: () => {
      currentTime += 1_000;
      return currentTime;
    }
  });

  const updated = await shared.update((current) => ({
    count: current.count + 1
  }));
  assert.equal(updated.count, 1);
});

function store(
  directory: string,
  timing: {
    readonly lockTimeoutMs?: number;
    readonly staleLockMs?: number;
    readonly now?: () => number;
  } = {}
): SharedFileStore<CounterStore> {
  return new SharedFileStore({
    directory,
    filename: 'counter.json',
    empty: () => ({ count: 0 }),
    decode: (value) => ({
      count:
        typeof value === 'object' &&
        value !== null &&
        'count' in value &&
        typeof value.count === 'number'
          ? value.count
          : 0
    }),
    ...timing
  });
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

function store(directory: string): SharedFileStore<CounterStore> {
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
    })
  });
}

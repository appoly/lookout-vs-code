import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSessionOrder,
  reorderSessionIds
} from '../src/sessionOrder';

test('normalizes persisted agent order against current sessions', () => {
  assert.deepEqual(
    normalizeSessionOrder(['b', 'stale', 'b', 42, 'a'], ['a', 'b', 'c']),
    ['b', 'a', 'c']
  );
});

test('moves dragged agents before a target and preserves their relative order', () => {
  assert.deepEqual(
    reorderSessionIds(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], ['d', 'b'], 'a'),
    ['b', 'd', 'a', 'c']
  );
});

test('moves an agent to the end when dropped on the Current Workspace group', () => {
  assert.deepEqual(
    reorderSessionIds(['a', 'b', 'c'], ['a', 'b', 'c'], ['a']),
    ['b', 'c', 'a']
  );
});

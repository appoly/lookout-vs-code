import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeErrorIdentity } from '../src/runtimeError';

test('keeps runtime error logging to bounded metadata tokens', () => {
  const ordinary = Object.assign(new Error('private path and command'), {
    code: 'ENOENT'
  });
  assert.deepEqual(runtimeErrorIdentity(ordinary), {
    name: 'Error',
    code: 'ENOENT'
  });

  const malicious = Object.assign(new Error('secret'), {
    name: 'Error\nLOOKOUT_NOTIFY_TOKEN=secret',
    code: 'not safe / private/path'
  });
  assert.deepEqual(runtimeErrorIdentity(malicious), { name: 'unknown' });
});

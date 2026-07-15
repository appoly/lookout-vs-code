import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CoordinationEndpointBroker } from '../src/coordinationEndpoint';
import { COORDINATION_PROTOCOL_VERSION } from '../src/coordinationModel';
import type { CoordinationEndpoint } from '../src/coordinationServer';

test('elects one owner and connects subsequent windows as clients', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-coordinator-'));
  const first = new CoordinationEndpointBroker(directory);
  const second = new CoordinationEndpointBroker(directory);
  try {
    const owner = await first.connectOrOwn('token', 'window-a');
    assert.equal(owner.state, 'connected');
    if (owner.state === 'connected') {
      assert.equal(owner.owned, true);
    }
    const client = await second.connectOrOwn('token', 'window-b');
    assert.equal(client.state, 'connected');
    if (client.state === 'connected') {
      assert.equal(client.owned, false);
      assert.equal(await client.client.health(), true);
    }
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('refuses to overwrite a coordinator owned by another protocol version', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-coordinator-'));
  await writeFile(
    path.join(directory, 'coordination-v1.endpoint.json'),
    JSON.stringify({ protocolVersion: 99, port: 1234, ownerId: 'future' }),
    'utf8'
  );
  await writeFile(
    path.join(directory, 'coordination-v1.owner.lock'),
    JSON.stringify({ pid: 1, createdAt: Date.now() }),
    'utf8'
  );
  const broker = new CoordinationEndpointBroker(directory);
  try {
    const result = await broker.connectOrOwn('token', 'window-a');
    assert.equal(result.state, 'incompatible');
  } finally {
    await broker.dispose();
  }
});

test('elects a replacement after the owner exits cleanly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-coordinator-'));
  const first = new CoordinationEndpointBroker(directory);
  const firstConnection = await first.connectOrOwn('token', 'window-a');
  assert.equal(firstConnection.state, 'connected');
  await first.dispose();

  const replacement = new CoordinationEndpointBroker(directory);
  try {
    const connection = await replacement.connectOrOwn('token', 'window-b');
    assert.equal(connection.state, 'connected');
    if (connection.state === 'connected') {
      assert.equal(connection.owned, true);
    }
  } finally {
    await replacement.dispose();
  }
});

test('stops a newly started server when endpoint publication fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lookout-coordinator-'));
  const endpointPath = path.join(directory, 'coordination-v1.endpoint.json');
  let stopped = false;
  const broker = new CoordinationEndpointBroker(directory, () => ({
    start: async (): Promise<CoordinationEndpoint> => {
      // Simulate a publication race after the broker's initial descriptor read.
      await mkdir(endpointPath);
      return {
        protocolVersion: COORDINATION_PROTOCOL_VERSION,
        port: 43_210,
        ownerId: 'window-a',
        startedAt: Date.now()
      };
    },
    stop: async (): Promise<void> => {
      stopped = true;
    }
  }));

  await assert.rejects(() => broker.connectOrOwn('token', 'window-a'));
  assert.equal(stopped, true);
  await broker.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CoordinationClient } from '../src/coordinationClient';
import {
  COORDINATION_PROTOCOL_VERSION,
  type CoordinatedWindowRegistration
} from '../src/coordinationModel';
import { CoordinationServer } from '../src/coordinationServer';

test('authenticates loopback clients and routes focus actions', async () => {
  const server = new CoordinationServer('shared-secret', 'owner');
  const endpoint = await server.start();
  try {
    const client = new CoordinationClient(endpoint, 'shared-secret');
    const unauthorized = new CoordinationClient(endpoint, 'wrong-secret');
    assert.equal(await client.health(), true);
    assert.equal(await unauthorized.health(), false);

    await client.heartbeat(registration('window-a', 'session-a'));
    await client.heartbeat(registration('window-b', 'session-b'));
    assert.equal(await client.focus('window-a', 'window-b', 'session-b'), true);
    const result = await client.heartbeat(registration('window-b', 'session-b'));
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].kind, 'focus-session');
    assert.equal(result.windows.some((window) => window.windowId === 'window-a'), true);
  } finally {
    await server.stop();
  }
});

function registration(
  windowId: string,
  sessionId: string
): CoordinatedWindowRegistration {
  return {
    protocolVersion: COORDINATION_PROTOCOL_VERSION,
    windowId,
    workspaceKey: `workspace-${windowId}`,
    workspaceLabel: `Workspace ${windowId}`,
    hostKind: 'local',
    observedAt: Date.now(),
    sessions: [{
      sessionId,
      label: `Agent ${windowId}`,
      kind: 'claude',
      status: 'running',
      unread: false,
      updatedAt: Date.now()
    }]
  };
}

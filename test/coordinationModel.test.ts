import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COORDINATION_LEASE_MS,
  COORDINATION_PROTOCOL_VERSION,
  CoordinationRegistry,
  decodeRegistration,
  type CoordinatedWindowRegistration
} from '../src/coordinationModel';

test('shares bounded live metadata and excludes the calling window', () => {
  let now = 1_000;
  const registry = new CoordinationRegistry(() => now);
  registry.heartbeat(registration('window-a', 'Project A', 'session-a'));
  const result = registry.heartbeat(registration('window-b', 'Project B', 'session-b'));
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].windowId, 'window-a');
  assert.equal(result.windows[0].sessions[0].label, 'Agent window-a');
  assert.equal(result.actions.length, 0);

  now += COORDINATION_LEASE_MS + 1;
  assert.equal(registry.snapshot().length, 0);
});

test('routes focus once and rejects absent targets', () => {
  const registry = new CoordinationRegistry(() => 10_000);
  registry.heartbeat(registration('window-a', 'A', 'session-a'));
  registry.heartbeat(registration('window-b', 'B', 'session-b'));
  assert.ok(registry.queueFocus('window-a', 'window-b', 'session-b'));
  assert.equal(registry.queueFocus('window-a', 'missing', 'session'), undefined);
  const delivered = registry.heartbeat(registration('window-b', 'B', 'session-b'));
  assert.equal(delivered.actions.length, 1);
  assert.equal(delivered.actions[0].sessionId, 'session-b');
  assert.equal(
    registry.heartbeat(registration('window-b', 'B', 'session-b')).actions.length,
    0
  );
});

test('registration decoder rejects protocol drift and sensitive unknown fields', () => {
  assert.equal(
    decodeRegistration({ ...registration('a', 'A', 's'), protocolVersion: 99 }),
    undefined
  );
  const decoded = decodeRegistration({
    ...registration('a', 'A', 's'),
    transcript: 'private transcript',
    command: 'secret command',
    sessions: [{
      ...registration('a', 'A', 's').sessions[0],
      output: 'private output'
    }]
  });
  const serialized = JSON.stringify(decoded);
  assert.doesNotMatch(serialized, /private transcript|secret command|private output/);
});

function registration(
  windowId: string,
  workspaceLabel: string,
  sessionId: string
): CoordinatedWindowRegistration {
  return {
    protocolVersion: COORDINATION_PROTOCOL_VERSION,
    windowId,
    workspaceKey: `workspace-${windowId}`,
    workspaceLabel,
    hostKind: 'local',
    observedAt: 1_000,
    sessions: [{
      sessionId,
      label: `Agent ${windowId}`,
      kind: 'codex',
      status: 'attention',
      unread: true,
      updatedAt: 1_000,
      providerSessionFingerprint: 'abc123'
    }]
  };
}

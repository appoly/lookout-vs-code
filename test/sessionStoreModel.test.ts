import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../src/sessionModel';
import {
  createPersistedSessionStore,
  decodeSessionStore,
  SESSION_STORE_SCHEMA_VERSION
} from '../src/sessionStoreModel';

test('migrates legacy sessions without fabricating provider identity or events', () => {
  const legacy = createSession('codex', 'Legacy', 'codex', '/repo', 1, 'one');
  const decoded = decodeSessionStore(undefined, [
    {
      ...legacy,
      providerSessions: undefined,
      lineage: undefined,
      integration: undefined
    }
  ]);
  assert.equal(decoded.migrated, true);
  assert.equal(decoded.store.schemaVersion, SESSION_STORE_SCHEMA_VERSION);
  assert.equal(decoded.store.sessions.length, 1);
  assert.deepEqual(decoded.store.sessions[0].providerSessions, []);
  assert.deepEqual(decoded.store.events, []);
});

test('persisted snapshots remove transient command state and custom commands', () => {
  const custom = {
    ...createSession('custom', 'Custom', 'custom --secret x', '/repo', 1, 'one'),
    runningCommands: [{ id: 'one', command: 'deploy --secret x' }],
    backgroundAgents: [{ id: 'child', label: 'Child' }]
  };
  const store = createPersistedSessionStore([custom], [], 1);
  assert.equal(store.sessions[0].command, '');
  assert.deepEqual(store.sessions[0].runningCommands, []);
  assert.deepEqual(store.sessions[0].backgroundAgents, []);
  assert.equal(JSON.stringify(store).includes('--secret'), false);
});

test('persists numeric token telemetry without delegated identities', () => {
  const session = {
    ...createSession('claude', 'Claude', 'claude', '/repo', 1, 'one'),
    tokenUsage: {
      source: 'claude-statusline' as const,
      observedAt: 2,
      contextTokens: 12_000,
      inputTokens: 11_000,
      outputTokens: 1_000,
      delegatedAgents: [
        { id: 'private-task-id', label: 'private task label', tokenCount: 5_000 }
      ]
    }
  };
  const stored = createPersistedSessionStore([session], [], 1).sessions[0];
  assert.equal(stored.tokenUsage?.contextTokens, 12_000);
  assert.deepEqual(stored.tokenUsage?.delegatedAgents, []);
  assert.doesNotMatch(JSON.stringify(stored), /private/);
});

test('decodes valid v2 state idempotently and advances event sequence', () => {
  const session = createSession('claude', 'One', 'claude', '/repo', 1, 'one');
  const current = {
    schemaVersion: 2,
    nextSequence: 1,
    sessions: [session],
    events: [
      {
        id: 'event-4',
        sequence: 4,
        sessionId: 'one',
        kind: 'provider-completed',
        observedAt: 4,
        source: 'provider-hook',
        summary: 'Agent completed',
        attention: 'notice'
      }
    ]
  };
  const decoded = decodeSessionStore(current, []);
  assert.equal(decoded.migrated, false);
  assert.equal(decoded.store.nextSequence, 5);
  assert.equal(decoded.store.events.length, 1);
});

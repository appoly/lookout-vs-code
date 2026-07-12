import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimGlobalHistoryIntent,
  createGlobalHistoryIntent,
  deleteGlobalHistoryRecords,
  emptyGlobalHistory,
  globalHistoryRecord,
  normalizeGlobalHistory,
  replaceWorkspaceHistory,
  type GlobalHistoryRecord,
  type WorkspaceIdentity
} from '../src/globalHistoryModel';
import type { AgentSession } from '../src/types';

const workspaceA: WorkspaceIdentity = {
  key: 'workspace-a',
  uri: 'file:///projects/a',
  label: 'A',
  hostKind: 'local',
  hostScope: 'host-a'
};
const workspaceB: WorkspaceIdentity = {
  ...workspaceA,
  key: 'workspace-b',
  uri: 'file:///projects/b',
  label: 'B'
};

test('projects session history through a strict metadata-only boundary', () => {
  const record = globalHistoryRecord(session(), workspaceA, {
    events: 7,
    attention: 2
  });
  const serialized = JSON.stringify(record);
  assert.equal(record.provider?.id, 'provider-session');
  assert.equal(record.eventCount, 7);
  assert.equal(record.attentionEventCount, 2);
  for (const canary of [
    'secret-command',
    'SECRET_ENV',
    'latest raw event',
    'delegated-private-label'
  ]) {
    assert.doesNotMatch(serialized, new RegExp(canary));
  }
});

test('replaces one workspace atomically while preserving other projects', () => {
  const a = globalHistoryRecord(session(), workspaceA, { events: 1, attention: 0 });
  const b = { ...a, id: 'record-b', workspace: workspaceB };
  let store = replaceWorkspaceHistory(emptyGlobalHistory(), workspaceA.key, [a], 100);
  store = replaceWorkspaceHistory(store, workspaceB.key, [b], 101);
  assert.deepEqual(store.records.map((record) => record.workspace.key).sort(), [
    workspaceA.key,
    workspaceB.key
  ]);

  store = replaceWorkspaceHistory(store, workspaceA.key, [], 200);
  assert.equal(store.records.some((record) => record.id === a.id), false);
  assert.equal(store.tombstones.some((item) => item.id === a.id), true);
  assert.equal(store.records.some((record) => record.id === b.id), true);
});

test('tombstones block stale windows but allow genuinely newer activity', () => {
  const original = globalHistoryRecord(session(), workspaceA, { events: 1, attention: 0 });
  let store = replaceWorkspaceHistory(emptyGlobalHistory(), workspaceA.key, [original], 100);
  store = deleteGlobalHistoryRecords(store, [original.id], 2_000);
  store = replaceWorkspaceHistory(store, workspaceA.key, [original], 2_100);
  assert.equal(store.records.length, 0, 'stale snapshot resurrected deleted history');

  const newer = { ...original, updatedAt: 3_000 };
  store = replaceWorkspaceHistory(store, workspaceA.key, [newer], 3_100);
  assert.equal(store.records[0]?.updatedAt, 3_000);
  assert.equal(store.tombstones.some((item) => item.id === original.id), false);
});

test('continuation intents are bounded, expiring, and claimed exactly once', () => {
  const record = globalHistoryRecord(session(), workspaceA, { events: 0, attention: 0 });
  let store = replaceWorkspaceHistory(emptyGlobalHistory(), workspaceA.key, [record], 100);
  const created = createGlobalHistoryIntent(store, record.id, 'resume', 200);
  assert.ok(created.intent);
  store = created.envelope;
  const claimed = claimGlobalHistoryIntent(store, workspaceA.key, 300);
  assert.equal(claimed.record?.id, record.id);
  assert.equal(claimed.intent?.operation, 'resume');
  assert.equal(
    claimGlobalHistoryIntent(claimed.envelope, workspaceA.key, 301).intent,
    undefined
  );
  assert.equal(
    claimGlobalHistoryIntent(created.envelope, workspaceA.key, 10_000_000).intent,
    undefined
  );
});

test('decoder rejects future schemas and strips malformed records', () => {
  assert.deepEqual(normalizeGlobalHistory({ version: 99, records: [{}] }), emptyGlobalHistory());
  assert.equal(
    normalizeGlobalHistory({ version: 1, revision: 1, records: [{ command: 'secret' }] })
      .records.length,
    0
  );
  const record = globalHistoryRecord(session(), workspaceA, { events: 0, attention: 0 });
  assert.equal(
    normalizeGlobalHistory({
      version: 1,
      revision: 1,
      records: [{
        ...record,
        workspace: { ...record.workspace, uri: 'command:workbench.action.closeWindow' }
      }]
    }).records.length,
    0
  );
});

function session(): AgentSession {
  return {
    id: 'lookout-session',
    kind: 'codex',
    label: 'Safe label',
    command: 'secret-command --token value',
    providerCommand: 'secret-command',
    cwd: 'C:\\projects\\a',
    status: 'closed',
    createdAt: 1_000,
    updatedAt: 1_500,
    terminalName: 'terminal',
    bridgeAvailable: false,
    unread: true,
    backgroundAgents: [{ id: 'SECRET_ENV', label: 'delegated-private-label' }],
    runningCommands: [{ id: 'command', command: 'SECRET_ENV=value' }],
    foregroundState: 'done',
    providerSessions: [{
      provider: 'codex',
      id: 'provider-session',
      firstSeenAt: 1_100,
      lastSeenAt: 1_200,
      state: 'available'
    }],
    lineage: { operation: 'new' },
    integration: {
      lifecycle: 'healthy',
      hookTrust: 'observed',
      lastHookAt: 1_400,
      conflict: 'latest raw event'
    },
    latestEvent: 'latest raw event'
  };
}

// Keep the imported DTO exercised as part of the public model contract.
const _recordShape: GlobalHistoryRecord | undefined = undefined;
void _recordShape;

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHistoryEntries,
  dedupeCoordinatedSessions,
  historyAvailability,
  historyAvailabilityLabel,
  liveSessionKey,
  safeHistoryLatestEvent
} from '../src/historyQuery';
import type {
  CoordinatedSession,
  CoordinatedWindow
} from '../src/coordinationModel';
import type { SessionEvent } from '../src/sessionEvents';
import type { AgentSession, ProviderSessionReference } from '../src/types';

test('distinguishes open, resumable, terminal-only, and closed history', () => {
  const open = session('open', 'custom', []);
  const resumable = session('resumable', 'codex', [reference('codex', 'available')]);
  const terminalOnly = session('terminal-only', 'custom', []);
  const closed = session('closed', 'claude', [
    reference('claude', 'provider-archived')
  ]);
  const missingIdentity = session('missing-identity', 'codex', []);
  const archived = { ...session('archived', 'codex', []), archivedAt: 10 };

  assert.equal(historyAvailability(open, true), 'open');
  assert.equal(historyAvailability(resumable, false), 'resumable');
  assert.equal(historyAvailability(terminalOnly, false), 'terminal-only');
  assert.equal(historyAvailability(closed, false), 'closed');
  assert.equal(historyAvailability(missingIdentity, false), 'terminal-only');
  assert.equal(historyAvailability(archived, false), 'archived');
});

test('builds bounded history ordered by latest safe activity evidence', () => {
  const older = session('older', 'custom', [], 10);
  const newerEventSession = session('newer-event', 'codex', [], 20);
  const newest = session('newest', 'claude', [], 100);
  const events: SessionEvent[] = [
    {
      id: 'e1',
      sequence: 1,
      sessionId: 'newer-event',
      kind: 'provider-completed',
      observedAt: 50,
      source: 'provider-hook',
      summary: 'unsafe stored summary',
      attention: 'notice'
    }
  ];

  const entries = buildHistoryEntries(
    [older, newerEventSession, newest],
    events,
    () => false,
    2
  );
  assert.deepEqual(entries.map((entry) => entry.session.id), [
    'newest',
    'newer-event'
  ]);
  assert.equal(entries[1]?.lastActivityAt, 50);
});

test('history labels and latest-event text use fixed enum mappings', () => {
  assert.equal(historyAvailabilityLabel('resumable'), 'Resumable');
  assert.equal(historyAvailabilityLabel('terminal-only'), 'Terminal-only history');
  assert.equal(historyAvailabilityLabel('archived'), 'Archived in Lookout');
  assert.equal(safeHistoryLatestEvent(undefined), 'No recorded events');
  assert.equal(
    safeHistoryLatestEvent({
      id: 'e',
      sequence: 1,
      sessionId: 's',
      kind: 'identity-conflict',
      observedAt: 1,
      source: 'system',
      summary: 'SECRET transcript content',
      attention: 'action'
    }),
    'Provider session identity conflict'
  );
});

test('deduplicates the same live session reported by two window leases', () => {
  const stale = coordinatedWindow('window-old', 'project-a', 100, [
    coordinatedSession('session-1', 'stale label'),
    coordinatedSession('session-2', 'only in old window')
  ]);
  const fresh = coordinatedWindow('window-new', 'project-a', 200, [
    coordinatedSession('session-1', 'fresh label')
  ]);
  const otherProject = coordinatedWindow('window-b', 'project-b', 150, [
    coordinatedSession('session-1', 'same ID, different project')
  ]);

  const deduped = dedupeCoordinatedSessions([stale, fresh, otherProject]);

  const keys = deduped.map((entry) =>
    liveSessionKey(entry.window.workspaceKey, entry.session.sessionId)
  );
  assert.equal(new Set(keys).size, deduped.length);
  assert.deepEqual(
    deduped
      .map((entry) => `${entry.window.windowId}:${entry.session.sessionId}`)
      .sort(),
    ['window-b:session-1', 'window-new:session-1', 'window-old:session-2']
  );
});

test('live session keys separate workspace and session identity', () => {
  assert.notEqual(liveSessionKey('a', 'b-c'), liveSessionKey('a-b', 'c'));
  assert.equal(liveSessionKey('w', 's'), liveSessionKey('w', 's'));
});

function coordinatedWindow(
  windowId: string,
  workspaceKey: string,
  observedAt: number,
  sessions: CoordinatedSession[]
): CoordinatedWindow {
  return {
    protocolVersion: 1,
    windowId,
    workspaceKey,
    workspaceLabel: workspaceKey,
    hostKind: 'local',
    observedAt,
    sessions,
    leaseExpiresAt: observedAt + 15_000
  };
}

function coordinatedSession(
  sessionId: string,
  label: string
): CoordinatedSession {
  return {
    sessionId,
    label,
    kind: 'claude',
    status: 'running',
    unread: false,
    updatedAt: 1
  };
}

function session(
  id: string,
  kind: AgentSession['kind'],
  providerSessions: ProviderSessionReference[],
  updatedAt = 1
): AgentSession {
  return {
    id,
    kind,
    label: id,
    command: kind,
    cwd: `/repo/${id}`,
    status: 'closed',
    createdAt: 1,
    updatedAt,
    terminalName: id,
    bridgeAvailable: false,
    unread: false,
    backgroundAgents: [],
    runningCommands: [],
    foregroundState: 'stopped',
    providerSessions,
    lineage: { operation: 'new' },
    integration: {
      lifecycle: 'disabled',
      hookTrust: 'not-applicable'
    }
  };
}

function reference(
  provider: ProviderSessionReference['provider'],
  state: ProviderSessionReference['state']
): ProviderSessionReference {
  return {
    provider,
    id: `${provider}-session`,
    firstSeenAt: 1,
    lastSeenAt: 2,
    state
  };
}

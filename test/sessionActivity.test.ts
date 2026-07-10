import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentEvent, normalizeSessionActivity } from '../src/sessionActivity';
import { createSession } from '../src/sessionModel';

test('does not request input while delegated agents are still running', () => {
  const starting = createSession('claude', 'Parallel work', 'claude', '/repo', 1, 's1');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's1', status: 'running' },
    2
  );
  const delegated = applyAgentEvent(
    working,
    {
      kind: 'background-start',
      sessionId: 's1',
      agentId: 'child-1',
      agentLabel: 'Explore'
    },
    3
  );
  const foregroundStopped = applyAgentEvent(
    delegated,
    { kind: 'foreground-stop', sessionId: 's1' },
    4
  );

  assert.equal(foregroundStopped.status, 'background');
  assert.equal(foregroundStopped.latestEvent, '1 delegated agent running');
  assert.equal(foregroundStopped.unread, false);

  const allFinished = applyAgentEvent(
    foregroundStopped,
    {
      kind: 'background-stop',
      sessionId: 's1',
      agentId: 'child-1',
      agentLabel: 'Explore'
    },
    5
  );
  assert.equal(allFinished.status, 'attention');
  assert.equal(allFinished.latestEvent, 'Agent is waiting for input');
  assert.equal(allFinished.unread, true);
});

test('a plain turn end goes idle rather than requesting input', () => {
  const starting = createSession('claude', 'Quick task', 'claude', '/repo', 1, 's-idle');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's-idle', status: 'running' },
    2
  );
  const finished = applyAgentEvent(
    working,
    { kind: 'foreground-stop', sessionId: 's-idle', reason: 'turn-end', message: 'Claude finished' },
    3
  );

  assert.equal(finished.status, 'idle');
  assert.equal(finished.latestEvent, 'Claude finished');
  assert.equal(finished.unread, true);
});

test('a turn end while delegated agents run still reports background', () => {
  const starting = createSession('claude', 'Delegating', 'claude', '/repo', 1, 's-bg');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's-bg', status: 'running' },
    2
  );
  const delegated = applyAgentEvent(
    working,
    {
      kind: 'background-start',
      sessionId: 's-bg',
      agentId: 'child-bg',
      agentLabel: 'Explore'
    },
    3
  );
  const stopped = applyAgentEvent(
    delegated,
    { kind: 'foreground-stop', sessionId: 's-bg', reason: 'turn-end' },
    4
  );

  assert.equal(stopped.status, 'background');
  assert.equal(stopped.latestEvent, '1 delegated agent running');
  assert.equal(stopped.unread, false);
});

test('permission attention wins over delegated-agent progress', () => {
  const starting = createSession('codex', 'Review', 'codex', '/repo', 1, 's2');
  const attention = applyAgentEvent(
    starting,
    {
      kind: 'status',
      sessionId: 's2',
      status: 'attention',
      message: 'Codex needs permission'
    },
    2
  );
  const withChild = applyAgentEvent(
    attention,
    {
      kind: 'background-start',
      sessionId: 's2',
      agentId: 'child-2',
      agentLabel: 'Reviewer'
    },
    3
  );

  assert.equal(withChild.status, 'attention');
  assert.equal(withChild.latestEvent, 'Codex needs permission');
  assert.equal(withChild.backgroundAgents.length, 1);
});

test('returns to foreground work when the last delegated agent finishes', () => {
  const starting = createSession('claude', 'Work', 'claude', '/repo', 1, 's3');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's3', status: 'running' },
    2
  );
  const delegated = applyAgentEvent(
    working,
    {
      kind: 'background-start',
      sessionId: 's3',
      agentId: 'child-3',
      agentLabel: 'Plan'
    },
    3
  );
  const resumed = applyAgentEvent(
    delegated,
    {
      kind: 'background-stop',
      sessionId: 's3',
      agentId: 'child-3',
      agentLabel: 'Plan'
    },
    4
  );

  assert.equal(resumed.status, 'running');
  assert.equal(resumed.latestEvent, 'Agent is working');
  assert.deepEqual(resumed.backgroundAgents, []);
});

test('normalizes restored sessions created before activity tracking', () => {
  const legacy = createSession('codex', 'Legacy', 'codex', '/repo', 1, 's4');
  const restored = normalizeSessionActivity({
    ...legacy,
    backgroundAgents: undefined,
    foregroundState: undefined
  } as unknown as typeof legacy);
  assert.deepEqual(restored.backgroundAgents, []);
  assert.equal(restored.foregroundState, 'unknown');
});

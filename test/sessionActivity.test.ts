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
    runningCommands: undefined,
    foregroundState: undefined
  } as unknown as typeof legacy);
  assert.deepEqual(restored.backgroundAgents, []);
  assert.deepEqual(restored.runningCommands, []);
  assert.equal(restored.foregroundState, 'unknown');
});

test('tracks a running command until it stops', () => {
  const starting = createSession('claude', 'Builds', 'claude', '/repo', 1, 'c1');
  const started = applyAgentEvent(
    starting,
    { kind: 'command-start', sessionId: 'c1', commandId: 't1', command: 'npm test' },
    2
  );
  assert.deepEqual(started.runningCommands, [{ id: 't1', command: 'npm test' }]);

  const stopped = applyAgentEvent(
    started,
    { kind: 'command-stop', sessionId: 'c1', commandId: 't1', command: 'npm test' },
    3
  );
  assert.deepEqual(stopped.runningCommands, []);
});

test('tracks MCP activity separately from shell commands', () => {
  const starting = createSession('codex', 'Apps', 'codex', '/repo', 1, 'mcp-1');
  const started = applyAgentEvent(
    starting,
    {
      kind: 'command-start',
      sessionId: 'mcp-1',
      commandId: 'call-1',
      command: 'codex_apps.github.fetch_pr',
      activityKind: 'mcp'
    },
    2
  );
  assert.deepEqual(started.runningCommands, [
    {
      id: 'call-1',
      command: 'codex_apps.github.fetch_pr',
      activityKind: 'mcp'
    }
  ]);
});

test('keeps concurrent commands distinct and removes only the one that stops', () => {
  const base = createSession('claude', 'Builds', 'claude', '/repo', 1, 'c2');
  const withBuild = applyAgentEvent(
    base,
    { kind: 'command-start', sessionId: 'c2', commandId: 'b', command: 'npm run build' },
    2
  );
  const withTest = applyAgentEvent(
    withBuild,
    { kind: 'command-start', sessionId: 'c2', commandId: 't', command: 'npm test' },
    3
  );
  assert.equal(withTest.runningCommands.length, 2);

  const buildDone = applyAgentEvent(
    withTest,
    { kind: 'command-stop', sessionId: 'c2', commandId: 'b', command: 'npm run build' },
    4
  );
  assert.deepEqual(buildDone.runningCommands, [{ id: 't', command: 'npm test' }]);
});

test('clears the newest matching command when a provider changes its tool-use ID', () => {
  const base = createSession('codex', 'Commands', 'codex', '/repo', 1, 'c-mismatch');
  const first = applyAgentEvent(
    base,
    { kind: 'command-start', sessionId: 'c-mismatch', commandId: 'one', command: 'git status' },
    2
  );
  const second = applyAgentEvent(
    first,
    { kind: 'command-start', sessionId: 'c-mismatch', commandId: 'two', command: 'git status' },
    3
  );
  const stopped = applyAgentEvent(
    second,
    { kind: 'command-stop', sessionId: 'c-mismatch', commandId: 'changed', command: 'git status' },
    4
  );
  assert.deepEqual(stopped.runningCommands, [{ id: 'one', command: 'git status' }]);
});

test('a finished turn clears any lingering running commands', () => {
  const base = createSession('claude', 'Builds', 'claude', '/repo', 1, 'c3');
  const working = applyAgentEvent(
    base,
    { kind: 'status', sessionId: 'c3', status: 'running' },
    2
  );
  const withCommand = applyAgentEvent(
    working,
    { kind: 'command-start', sessionId: 'c3', commandId: 'srv', command: 'npm run dev' },
    3
  );
  assert.equal(withCommand.runningCommands.length, 1);

  const finished = applyAgentEvent(
    withCommand,
    { kind: 'foreground-stop', sessionId: 'c3', reason: 'turn-end' },
    4
  );
  assert.deepEqual(finished.runningCommands, []);
});

test('a clean turn end goes idle when the last delegated agent drains later', () => {
  const starting = createSession('claude', 'Drain', 'claude', '/repo', 1, 's-drain');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's-drain', status: 'running' },
    2
  );
  const delegated = applyAgentEvent(
    working,
    {
      kind: 'background-start',
      sessionId: 's-drain',
      agentId: 'child-d',
      agentLabel: 'Explore'
    },
    3
  );
  const turnEnded = applyAgentEvent(
    delegated,
    { kind: 'foreground-stop', sessionId: 's-drain', reason: 'turn-end' },
    4
  );
  assert.equal(turnEnded.status, 'background');

  const drained = applyAgentEvent(
    turnEnded,
    {
      kind: 'background-stop',
      sessionId: 's-drain',
      agentId: 'child-d',
      agentLabel: 'Explore'
    },
    5
  );
  assert.equal(drained.status, 'idle');
  assert.equal(drained.latestEvent, 'Agent finished');
  assert.equal(drained.unread, true);
});

test('a tool call clears a mid-turn permission attention', () => {
  const starting = createSession('claude', 'Approve', 'claude', '/repo', 1, 's-perm');
  const working = applyAgentEvent(
    starting,
    { kind: 'status', sessionId: 's-perm', status: 'running' },
    2
  );
  const needsPermission = applyAgentEvent(
    working,
    {
      kind: 'status',
      sessionId: 's-perm',
      status: 'attention',
      message: 'Claude needs permission'
    },
    3
  );
  assert.equal(needsPermission.status, 'attention');

  const approved = applyAgentEvent(
    needsPermission,
    {
      kind: 'command-start',
      sessionId: 's-perm',
      commandId: 'tool-1',
      command: 'npm test'
    },
    4
  );
  assert.equal(approved.status, 'running');
  assert.equal(approved.latestEvent, 'Agent is working');
  assert.deepEqual(
    approved.runningCommands.map((entry) => entry.command),
    ['npm test']
  );

  const stillWaiting = applyAgentEvent(
    needsPermission,
    { kind: 'foreground-stop', sessionId: 's-perm' },
    5
  );
  assert.equal(stillWaiting.status, 'attention');
});

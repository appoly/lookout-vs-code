import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSession,
  isActiveSession,
  markSessionRead,
  summarizeSessions,
  terminalName,
  transitionSession
} from '../src/sessionModel';

test('creates a stable, identifiable terminal session', () => {
  const session = createSession('codex', ' API work ', ' codex ', '/repo', 10, 'id-1');
  assert.equal(session.label, 'API work');
  assert.equal(session.command, 'codex');
  assert.equal(session.terminalName, 'Lookout: API work [id-1]');
  assert.equal(session.unread, false);
  assert.equal(terminalName('id-1', ' API work '), session.terminalName);
});

test('attention is active and unread until focused', () => {
  const starting = createSession('claude', 'Tests', 'claude', '/repo', 10, 'id-2');
  const attention = transitionSession(
    starting,
    'attention',
    20,
    undefined,
    'Approve command?'
  );
  assert.equal(isActiveSession(attention), true);
  assert.equal(attention.unread, true);
  assert.equal(attention.latestEvent, 'Approve command?');
  assert.equal(markSessionRead(attention, 30).unread, false);
});

test('an open agent process can be active without claiming it is working', () => {
  const session = transitionSession(
    createSession('codex', 'Work', 'codex', '/repo', 10, 'id-active'),
    'active',
    20,
    undefined,
    'Agent session active'
  );
  assert.equal(isActiveSession(session), true);
  assert.equal(session.status, 'active');
  assert.equal(session.unread, false);
});

test('summarizes active and attention counts', () => {
  const one = createSession('codex', 'One', 'codex', '/repo', 1, 'one');
  const two = transitionSession(
    createSession('claude', 'Two', 'claude', '/repo', 2, 'two'),
    'attention',
    3
  );
  assert.equal(summarizeSessions([one, two]), '2 active · 1 need attention');
});

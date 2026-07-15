import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRestoredTerminals } from '../src/restoreTerminalMatcher';

test('matches explicit Lookout session ids before terminal names', () => {
  const exact = { name: 'PowerShell' };
  const other = { name: 'PowerShell' };
  const matches = matchRestoredTerminals(
    [
      { id: 'session-a', terminalName: 'PowerShell' },
      { id: 'session-b', terminalName: 'PowerShell' }
    ],
    [
      { value: other, name: 'PowerShell', sessionId: 'session-b' },
      { value: exact, name: 'PowerShell', sessionId: 'session-a' }
    ]
  );

  assert.equal(matches.get('session-a'), exact);
  assert.equal(matches.get('session-b'), other);
});

test('refuses ambiguous name-only restoration and never reuses a terminal', () => {
  const terminalA = { name: 'bash' };
  const terminalB = { name: 'bash' };
  const matches = matchRestoredTerminals(
    [
      { id: 'session-a', terminalName: 'bash' },
      { id: 'session-b', terminalName: 'bash' },
      { id: 'session-c', terminalName: 'zsh' }
    ],
    [
      { value: terminalA, name: 'bash' },
      { value: terminalB, name: 'bash' },
      { value: terminalB, name: 'zsh' }
    ]
  );

  assert.equal(matches.has('session-a'), false);
  assert.equal(matches.has('session-b'), false);
  assert.equal(matches.has('session-c'), true);
  assert.equal(new Set(matches.values()).size, matches.size);
});

test('does not name-match a terminal owned by a different Lookout session', () => {
  const terminal = { name: 'Claude' };
  const matches = matchRestoredTerminals(
    [{ id: 'saved-session', terminalName: 'Claude' }],
    [{ value: terminal, name: 'Claude', sessionId: 'different-session' }]
  );

  assert.equal(matches.size, 0);
});

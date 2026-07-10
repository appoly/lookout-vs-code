import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDirectAgentCommand,
  shellQuote,
  withCodexTurnNotification
} from '../src/agentCommand';

test('adds a session-only Codex turn notification', () => {
  assert.equal(
    withCodexTurnNotification('codex --no-alt-screen', '/extension/notify.js', 'linux'),
    "codex --no-alt-screen -c 'notify=[\"node\",\"/extension/notify.js\",\"attention\",\"Codex is waiting for input\"]'"
  );
});

test('preserves custom and already configured Codex commands', () => {
  assert.equal(
    withCodexTurnNotification(
      "codex -c 'notify=[\"my-notifier\"]'",
      '/extension/notify.js',
      'linux'
    ),
    "codex -c 'notify=[\"my-notifier\"]'"
  );
  assert.equal(
    withCodexTurnNotification('wrapper codex', '/extension/notify.js', 'linux'),
    'wrapper codex'
  );
});

test('recognizes direct provider commands without accepting shell expressions', () => {
  assert.equal(isDirectAgentCommand('/usr/bin/codex resume', 'codex'), true);
  assert.equal(isDirectAgentCommand('claude --model opus', 'claude'), true);
  assert.equal(isDirectAgentCommand('codex && echo done', 'codex'), false);
  assert.equal(shellQuote("it's ready", 'linux'), "'it'\\''s ready'");
});

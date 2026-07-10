import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDirectAgentCommand,
  shellQuote,
  withCodexLifecycleIntegration
} from '../src/agentCommand';

test('adds session-only Codex turn and delegated-agent lifecycle events', () => {
  const command = withCodexLifecycleIntegration(
    'codex --no-alt-screen',
    '/extension/notify.js',
    'linux'
  );
  assert.match(command, /notify=.*turn-end/);
  assert.match(command, /features\.hooks=true/);
  assert.match(command, /hooks\.Stop=.*--hook codex turn-end/);
  assert.match(command, /hooks\.UserPromptSubmit=/);
  assert.match(command, /hooks\.PermissionRequest=/);
  assert.match(command, /hooks\.SubagentStart=/);
  assert.match(command, /hooks\.SubagentStop=/);
  assert.match(command, /hooks\.Stop=/);
  assert.match(command, /--hook codex background-start/);
});

test('preserves explicit Codex notifier and hook overrides', () => {
  const explicitNotifier = withCodexLifecycleIntegration(
    "codex -c 'notify=[\"my-notifier\"]'",
    '/extension/notify.js',
    'linux'
  );
  assert.doesNotMatch(explicitNotifier, /Lookout is waiting/);
  assert.match(explicitNotifier, /hooks\.SubagentStart=/);

  const explicitHooks = withCodexLifecycleIntegration(
    "codex -c 'hooks.Stop=[]'",
    '/extension/notify.js',
    'linux'
  );
  assert.match(explicitHooks, /notify=/);
  assert.doesNotMatch(explicitHooks, /hooks\.SubagentStart=/);

  assert.equal(
    withCodexLifecycleIntegration('wrapper codex', '/extension/notify.js', 'linux'),
    'wrapper codex'
  );
});

test('recognizes direct provider commands without accepting shell expressions', () => {
  assert.equal(isDirectAgentCommand('/usr/bin/codex resume', 'codex'), true);
  assert.equal(isDirectAgentCommand('claude --model opus', 'claude'), true);
  assert.equal(isDirectAgentCommand('codex && echo done', 'codex'), false);
  assert.equal(shellQuote("it's ready", 'linux'), "'it'\\''s ready'");
});

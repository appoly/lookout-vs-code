import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { normalizeProviderEvent } from '../src/providerEventNormalization';

test('captures Codex identity and resume source without forwarding sensitive fields', () => {
  const payload = fixture('codex-session-start.json');
  const event = normalizeProviderEvent({
    lookoutSessionId: 'lookout-codex',
    provider: 'codex',
    action: 'session-start',
    explicitMessage: '',
    providerPayload: payload,
    captureCommandOutput: false
  });

  assert.deepEqual(event, {
    kind: 'provider-session',
    sessionId: 'lookout-codex',
    provider: 'codex',
    providerSessionId: '0190f4aa-0f98-7000-8000-111111111111',
    providerSessionSource: 'resume'
  });
  assertPrivateFieldsAbsent(event, payload);
});

test('captures Claude identity on ordinary lifecycle events', () => {
  const payload = fixture('claude-session-start.json');
  const event = normalizeProviderEvent({
    lookoutSessionId: 'lookout-claude',
    provider: 'claude',
    action: 'running',
    explicitMessage: 'Claude is working',
    providerPayload: payload,
    captureCommandOutput: false
  });

  assert.deepEqual(event, {
    kind: 'status',
    sessionId: 'lookout-claude',
    status: 'running',
    message: 'Claude is working',
    provider: 'claude',
    providerSessionId: 'claude-session-123',
    providerSessionSource: 'startup'
  });
  assertPrivateFieldsAbsent(event, payload);
});

test('allow-lists source values and ignores provider payload messages', () => {
  const event = normalizeProviderEvent({
    lookoutSessionId: 'lookout-1',
    provider: 'codex',
    action: 'attention',
    explicitMessage: '',
    providerPayload: {
      session_id: 'provider-1',
      source: 'future-source',
      message: 'potentially sensitive provider text',
      prompt: 'private prompt'
    },
    captureCommandOutput: false
  });

  assert.deepEqual(event, {
    kind: 'status',
    sessionId: 'lookout-1',
    status: 'attention',
    message: 'Agent needs attention',
    provider: 'codex',
    providerSessionId: 'provider-1'
  });
});

test('preserves allow-listed command metadata and opt-in bounded results', () => {
  const event = normalizeProviderEvent({
    lookoutSessionId: 'lookout-1',
    provider: 'claude',
    action: 'command-stop',
    explicitMessage: '',
    providerPayload: {
      session_id: 'provider-1',
      tool_use_id: 'tool-1',
      tool_input: { command: 'npm test', ignored: 'secret' },
      tool_response: { stdout: 'passed', stderr: '' },
      duration_ms: 42,
      transcript_path: '/private/transcript.jsonl'
    },
    captureCommandOutput: true
  });

  assert.deepEqual(event, {
    kind: 'command-stop',
    sessionId: 'lookout-1',
    commandId: 'tool-1',
    command: 'npm test',
    result: { outcome: 'completed', durationMs: 42, stdout: 'passed' },
    provider: 'claude',
    providerSessionId: 'provider-1'
  });
});

test('captures only the bounded identifier for MCP activity', () => {
  const payload = {
    tool_name: 'codex_apps.github.fetch_pr',
    call_id: 'mcp-call-1',
    tool_input: {
      repository: 'private/repository',
      pull_number: 42
    },
    prompt: 'private prompt'
  };
  const event = normalizeProviderEvent({
    lookoutSessionId: 'lookout-1',
    provider: 'codex',
    action: 'command-start',
    explicitMessage: '',
    providerPayload: payload,
    captureCommandOutput: false
  });

  assert.deepEqual(event, {
    kind: 'command-start',
    sessionId: 'lookout-1',
    commandId: 'mcp-call-1',
    command: 'codex_apps.github.fetch_pr',
    activityKind: 'mcp'
  });
  assert.equal(JSON.stringify(event).includes('private/repository'), false);

  const completed = normalizeProviderEvent({
    lookoutSessionId: 'lookout-1',
    provider: 'codex',
    action: 'command-stop',
    explicitMessage: '',
    providerPayload: {
      ...payload,
      tool_response: { output: 'private MCP result' }
    },
    captureCommandOutput: true
  });
  assert.equal('result' in completed, false);
  assert.equal(JSON.stringify(completed).includes('private MCP result'), false);
});

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'hooks', name),
      'utf8'
    )
  ) as Record<string, unknown>;
}

function assertPrivateFieldsAbsent(
  event: Record<string, unknown>,
  payload: Record<string, unknown>
): void {
  const serialized = JSON.stringify(event);
  for (const key of [
    'transcript_path',
    'prompt',
    'last_assistant_message',
    'future_provider_field',
    'unknown_text'
  ]) {
    assert.equal(serialized.includes(key), false, key);
    const value = payload[key];
    if (typeof value === 'string') {
      assert.equal(serialized.includes(value), false, `${key} value`);
    }
  }
}

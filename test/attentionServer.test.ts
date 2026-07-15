import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import test from 'node:test';
import {
  AttentionServer,
  type AttentionEndpoint
} from '../src/attentionServer';
import type { AgentEvent } from '../src/types';
import type { UsageBridgeEvent } from '../src/usageTypes';

test('accepts authenticated agent and usage events on loopback', async (context) => {
  const agentEvents: AgentEvent[] = [];
  const usageEvents: UsageBridgeEvent[] = [];
  const server = new AttentionServer(
    (event) => agentEvents.push(event),
    (event) => usageEvents.push(event)
  );
  try {
    let endpoint: AttentionEndpoint;
    try {
      endpoint = await server.start();
    } catch (error) {
      if (isNodeError(error) && error.code === 'EPERM') {
        context.skip('Loopback listeners are disabled by this sandbox');
        return;
      }
      throw error;
    }
    const eventResponse = await post(endpoint.url, endpoint.token, {
      sessionId: 'session-1',
      status: 'attention',
      message: 'Approve command?'
    });
    assert.equal(eventResponse.status, 204);
    assert.deepEqual(agentEvents, [
      {
        kind: 'status',
        sessionId: 'session-1',
        status: 'attention',
        message: 'Approve command?'
      }
    ]);

    const backgroundResponse = await post(endpoint.url, endpoint.token, {
      kind: 'background-start',
      sessionId: 'session-1',
      agentId: 'agent-42',
      agentLabel: 'Explore'
    });
    assert.equal(backgroundResponse.status, 204);
    assert.deepEqual(agentEvents[1], {
      kind: 'background-start',
      sessionId: 'session-1',
      agentId: 'agent-42',
      agentLabel: 'Explore'
    });

    const hookResult = await runNotify(
      endpoint,
      ['--hook', 'codex', 'background-start'],
      {
        agent_id: 'agent-from-hook',
        agent_type: 'Reviewer'
      }
    );
    assert.equal(hookResult.code, 0);
    assert.equal(hookResult.stdout.trim(), '{}');
    assert.deepEqual(agentEvents[2], {
      kind: 'background-start',
      sessionId: 'session-from-hook',
      agentId: 'agent-from-hook',
      agentLabel: 'Reviewer'
    });

    const turnEndResult = await runNotify(
      endpoint,
      ['turn-end', 'Codex finished'],
      {}
    );
    assert.equal(turnEndResult.code, 0);
    assert.deepEqual(agentEvents[3], {
      kind: 'foreground-stop',
      sessionId: 'session-from-hook',
      reason: 'turn-end',
      message: 'Codex finished'
    });

    const waitingResponse = await post(endpoint.url, endpoint.token, {
      kind: 'foreground-stop',
      sessionId: 'session-1',
      reason: 'bogus',
      message: 'Agent is waiting for input'
    });
    assert.equal(waitingResponse.status, 204);
    assert.deepEqual(agentEvents[4], {
      kind: 'foreground-stop',
      sessionId: 'session-1',
      message: 'Agent is waiting for input'
    });

    const commandResponse = await post(endpoint.url, endpoint.token, {
      kind: 'command-start',
      sessionId: 'session-1',
      commandId: 'call-1',
      command: 'npm   run\tbuild'
    });
    assert.equal(commandResponse.status, 204);
    assert.deepEqual(agentEvents[5], {
      kind: 'command-start',
      sessionId: 'session-1',
      commandId: 'call-1',
      command: 'npm run build'
    });

    const commandHookResult = await runNotify(
      endpoint,
      ['--hook', 'claude', 'command-start'],
      { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'abc' }
    );
    assert.equal(commandHookResult.code, 0);
    assert.deepEqual(agentEvents[6], {
      kind: 'command-start',
      sessionId: 'session-from-hook',
      commandId: 'abc',
      command: 'npm test'
    });

    const mcpHookResult = await runNotify(
      endpoint,
      ['--hook', 'codex', 'command-start'],
      {
        tool_name: 'codex_apps.github.fetch_pr',
        call_id: 'mcp-1',
        tool_input: { repository: 'private/repository', pull_number: 4 }
      }
    );
    assert.equal(mcpHookResult.code, 0);
    assert.equal(mcpHookResult.stdout.trim(), '{}');
    assert.deepEqual(agentEvents[7], {
      kind: 'command-start',
      sessionId: 'session-from-hook',
      commandId: 'mcp-1',
      command: 'codex_apps.github.fetch_pr',
      activityKind: 'mcp'
    });

    const resultHook = await runNotify(
      endpoint,
      ['--hook', 'claude', 'command-stop'],
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'result-1',
        duration_ms: 24,
        tool_response: { stdout: 'passed', stderr: '' }
      },
      { LOOKOUT_CAPTURE_COMMAND_OUTPUT: '1' }
    );
    assert.equal(resultHook.code, 0);
    assert.deepEqual(agentEvents[8], {
      kind: 'command-stop',
      sessionId: 'session-from-hook',
      commandId: 'result-1',
      command: 'npm test',
      result: { outcome: 'completed', durationMs: 24, stdout: 'passed' }
    });

    const identityResponse = await post(endpoint.url, endpoint.token, {
      kind: 'provider-session',
      sessionId: 'session-1',
      provider: 'codex',
      providerSessionId: 'provider-session-1',
      providerSessionSource: 'startup',
      transcript_path: 'must-not-cross-the-bridge'
    });
    assert.equal(identityResponse.status, 204);
    assert.deepEqual(agentEvents.at(-1), {
      kind: 'provider-session',
      sessionId: 'session-1',
      provider: 'codex',
      providerSessionId: 'provider-session-1',
      providerSessionSource: 'startup'
    });

    const usageResponse = await post(
      endpoint.url.replace(/\/events$/, '/usage'),
      endpoint.token,
      {
        provider: 'claude',
        observedAt: 42,
        sessionId: 'session-1',
        windows: [
          { id: 'five_hour', label: '5 hour', usedPercent: 150 }
        ],
        tokenUsage: {
          source: 'claude-statusline',
          observedAt: 42,
          contextTokens: 12_000,
          inputTokens: 11_000,
          outputTokens: 1_000,
          contextUsedPercent: 6,
          delegatedAgents: [
            { id: 'child-1', label: 'Review', tokenCount: 4_000 }
          ]
        }
      }
    );
    assert.equal(usageResponse.status, 204);
    const usage = usageEvents[0];
    assert.ok(usage && usage.kind !== 'delegated-agents');
    assert.equal(usage.windows[0]?.usedPercent, 100);
    assert.equal(usage.sessionId, 'session-1');
    assert.equal(usage.tokenUsage?.contextTokens, 12_000);
    assert.equal(
      usage.tokenUsage?.delegatedAgents[0]?.tokenCount,
      4_000
    );

    const delegatedResponse = await post(
      endpoint.url.replace(/\/events$/, '/usage'),
      endpoint.token,
      {
        kind: 'delegated-agents',
        provider: 'claude',
        observedAt: 43,
        sessionId: 'session-1',
        delegatedAgents: [
          { id: 'child-1', label: 'Review', tokenCount: 4_500 }
        ]
      }
    );
    assert.equal(delegatedResponse.status, 204);
    const delegated = usageEvents[1];
    assert.ok(delegated && delegated.kind === 'delegated-agents');
    assert.equal(delegated.delegatedAgents[0]?.tokenCount, 4_500);

    const unauthorized = await post(endpoint.url, 'wrong-token', {
      sessionId: 'session-1',
      status: 'attention'
    });
    assert.equal(unauthorized.status, 404);

    const rejectedHook = await runNotify(
      { ...endpoint, token: 'wrong-token' },
      ['--hook', 'codex', 'turn-end'],
      { hook_event_name: 'Stop' }
    );
    assert.equal(rejectedHook.code, 0);
    assert.equal(rejectedHook.stdout.trim(), '{}');
    assert.equal(rejectedHook.stderr, '');

    server.dispose();
    const staleCodexHook = await runNotify(
      endpoint,
      ['--hook', 'codex', 'turn-end'],
      { hook_event_name: 'Stop' }
    );
    assert.equal(staleCodexHook.code, 0);
    assert.equal(staleCodexHook.stdout.trim(), '{}');
    assert.equal(staleCodexHook.stderr, '');
    const staleClaudeHook = await runNotify(
      endpoint,
      ['--hook', 'claude', 'turn-end'],
      { hook_event_name: 'Stop' }
    );
    assert.equal(staleClaudeHook.code, 0);
    assert.equal(staleClaudeHook.stdout, '');
    assert.equal(staleClaudeHook.stderr, '');
  } finally {
    server.dispose();
  }
});

test('provider hooks fail open when their Lookout bridge is stale', async () => {
  const result = await runNotify(
    {
      url: 'http://127.0.0.1:1/events',
      token: 'stale-bridge-token'
    },
    ['--hook', 'codex', 'turn-end'],
    { hook_event_name: 'Stop' }
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '{}');
});

test('custom attention commands report stale bridge delivery failures', async () => {
  const result = await runNotify(
    {
      url: 'http://127.0.0.1:1/events',
      token: 'stale-bridge-token'
    },
    ['attention'],
    {}
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Lookout notification failed\n');
});

function post(url: string, token: string, value: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(value)
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

async function runNotify(
  endpoint: AttentionEndpoint,
  args: readonly string[],
  input: object,
  extraEnvironment: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    [path.resolve(__dirname, '../src/notify.js'), ...args],
    {
      env: {
        ...process.env,
        LOOKOUT_NOTIFY_URL: endpoint.url,
        LOOKOUT_NOTIFY_TOKEN: endpoint.token,
        LOOKOUT_SESSION_ID: 'session-from-hook',
        ...extraEnvironment
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(JSON.stringify(input));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout, stderr };
}

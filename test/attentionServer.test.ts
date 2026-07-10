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

    const usageResponse = await post(
      endpoint.url.replace(/\/events$/, '/usage'),
      endpoint.token,
      {
        provider: 'claude',
        observedAt: 42,
        windows: [
          { id: 'five_hour', label: '5 hour', usedPercent: 150 }
        ]
      }
    );
    assert.equal(usageResponse.status, 204);
    assert.equal(usageEvents[0]?.windows[0]?.usedPercent, 100);

    const unauthorized = await post(endpoint.url, 'wrong-token', {
      sessionId: 'session-1',
      status: 'attention'
    });
    assert.equal(unauthorized.status, 404);
  } finally {
    server.dispose();
  }
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
  input: object
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(
    process.execPath,
    [path.resolve(__dirname, '../src/notify.js'), ...args],
    {
      env: {
        ...process.env,
        PARFUL_NOTIFY_URL: endpoint.url,
        PARFUL_NOTIFY_TOKEN: endpoint.token,
        PARFUL_SESSION_ID: 'session-from-hook'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stdin.end(JSON.stringify(input));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, stdout };
}

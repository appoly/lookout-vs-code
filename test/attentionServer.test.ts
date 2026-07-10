import assert from 'node:assert/strict';
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
        sessionId: 'session-1',
        status: 'attention',
        message: 'Approve command?'
      }
    ]);

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

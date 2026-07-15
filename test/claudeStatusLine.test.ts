import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import * as path from 'node:path';
import test from 'node:test';

const helper = path.resolve(__dirname, '..', 'src', 'claudeStatusLine.js');

test('subagent status lines post delegated data without replacing account or context usage', async () => {
  let received: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >;
      response.writeHead(204).end();
    });
  });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await runHelper(
      ['--subagents'],
      {
        session_id: 'provider-session',
        columns: 120,
        tasks: [{ id: 'agent-1', name: 'Explore', tokenCount: 321 }]
      },
      `http://127.0.0.1:${address.port}/usage`
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(received?.kind, 'delegated-agents');
    assert.equal(received?.sessionId, 'lookout-session');
    assert.deepEqual(received?.delegatedAgents, [
      { id: 'agent-1', label: 'Explore', tokenCount: 321 }
    ]);
    assert.equal('windows' in (received ?? {}), false);
    assert.equal('tokenUsage' in (received ?? {}), false);
  } finally {
    server.close();
  }
});

test('subagent status lines stay silent when the usage bridge fails', async () => {
  const server = createServer((request) => request.socket.destroy());
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await runHelper(
      ['--subagents'],
      { columns: 120, tasks: [] },
      `http://127.0.0.1:${address.port}/usage`
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    server.close();
  }
});

test('subagent status lines cap oversized input and fail open silently', async () => {
  const result = await runHelper(
    ['--subagents'],
    { padding: 'x'.repeat(70 * 1024) },
    'http://127.0.0.1:1/usage'
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function runHelper(
  args: readonly string[],
  input: unknown,
  url: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      env: {
        ...process.env,
        LOOKOUT_USAGE_URL: url,
        LOOKOUT_NOTIFY_TOKEN: 'test-token',
        LOOKOUT_SESSION_ID: 'lookout-session'
      },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

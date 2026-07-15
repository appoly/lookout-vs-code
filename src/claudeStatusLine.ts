import { request } from 'node:http';
import {
  formatClaudeUsage,
  normalizeClaudeDelegatedAgentTokenUsage,
  normalizeClaudeSessionTokenUsage,
  normalizeClaudeUsage
} from './claudeUsage';

const subagentMode = process.argv.includes('--subagents');
const MAX_STDIN_BYTES = 64 * 1024;

async function main(): Promise<void> {
  const input = await readStdin();
  const parsed: unknown = JSON.parse(input);
  const observedAt = Date.now();
  if (subagentMode) {
    const sessionId = process.env.LOOKOUT_SESSION_ID;
    if (sessionId) {
      await postUsage({
        kind: 'delegated-agents',
        provider: 'claude',
        observedAt,
        sessionId,
        delegatedAgents: normalizeClaudeDelegatedAgentTokenUsage(parsed)
      });
    }
    return;
  }

  const windows = normalizeClaudeUsage(parsed);
  const tokenUsage = normalizeClaudeSessionTokenUsage(parsed, observedAt);

  if (windows.length > 0 || tokenUsage) {
    await postUsage({
      provider: 'claude',
      observedAt,
      windows,
      ...(process.env.LOOKOUT_SESSION_ID
        ? { sessionId: process.env.LOOKOUT_SESSION_ID }
        : {}),
      ...(tokenUsage ? { tokenUsage } : {})
    });
  }
  process.stdout.write(formatClaudeUsage(windows));
}

async function postUsage(body: object): Promise<void> {
  const url = process.env.LOOKOUT_USAGE_URL;
  const token = process.env.LOOKOUT_NOTIFY_TOKEN;
  if (!url || !token) {
    return;
  }
  const serialized = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized)
        }
      },
      (response) => {
        response.resume();
        response.on('end', resolve);
      }
    );
    req.once('error', reject);
    // Never let a stale endpoint stall the status line render.
    req.setTimeout(3_000, () => {
      req.destroy(new Error('Lookout usage post timed out'));
    });
    req.end(serialized);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error('Claude status-line input exceeded the size limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

void main().catch(() => {
  if (!subagentMode) {
    process.stdout.write('Claude');
  }
});

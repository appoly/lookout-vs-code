import { request } from 'node:http';
import { formatClaudeUsage, normalizeClaudeUsage } from './claudeUsage';

async function main(): Promise<void> {
  const input = await readStdin();
  const parsed: unknown = JSON.parse(input);
  const windows = normalizeClaudeUsage(parsed);

  if (windows.length > 0) {
    await postUsage({
      provider: 'claude',
      observedAt: Date.now(),
      windows
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
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

void main().catch(() => {
  process.stdout.write('Claude');
});

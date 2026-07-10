import { request } from 'node:http';

interface ClaudeWindow {
  readonly used_percentage?: number;
  readonly resets_at?: number;
}

interface ClaudeStatusInput {
  readonly rate_limits?: {
    readonly five_hour?: ClaudeWindow;
    readonly seven_day?: ClaudeWindow;
  };
}

async function main(): Promise<void> {
  const input = await readStdin();
  const parsed = JSON.parse(input) as ClaudeStatusInput;
  const windows = [
    normalizeWindow('five_hour', '5 hour', 300, parsed.rate_limits?.five_hour),
    normalizeWindow('seven_day', '7 day', 10080, parsed.rate_limits?.seven_day)
  ].filter((value) => value !== undefined);

  if (windows.length > 0) {
    await postUsage({
      provider: 'claude',
      observedAt: Date.now(),
      windows
    });
  }
  process.stdout.write(
    windows.length > 0
      ? `Claude · ${windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(' · ')}`
      : 'Claude · usage waiting for first response'
  );
}

function normalizeWindow(
  id: string,
  label: string,
  windowMinutes: number,
  value: ClaudeWindow | undefined
): { id: string; label: string; usedPercent: number; resetsAt?: number; windowMinutes: number } | undefined {
  if (!value || typeof value.used_percentage !== 'number') {
    return undefined;
  }
  return {
    id,
    label,
    usedPercent: Math.max(0, Math.min(100, value.used_percentage)),
    windowMinutes,
    ...(typeof value.resets_at === 'number' ? { resetsAt: value.resets_at } : {})
  };
}

async function postUsage(body: object): Promise<void> {
  const url = process.env.MULTITERM_USAGE_URL;
  const token = process.env.MULTITERM_NOTIFY_TOKEN;
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

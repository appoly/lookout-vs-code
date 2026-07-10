import { request } from 'node:http';

type EventStatus = 'running' | 'attention' | 'completed' | 'failed';

const statuses = new Set<EventStatus>([
  'running',
  'attention',
  'completed',
  'failed'
]);

async function main(): Promise<void> {
  const url = process.env.MULTITERM_NOTIFY_URL;
  const token = process.env.MULTITERM_NOTIFY_TOKEN;
  const sessionId = process.env.MULTITERM_SESSION_ID;
  if (!url || !token || !sessionId) {
    process.exitCode = 2;
    return;
  }

  const first = process.argv[2] as EventStatus | undefined;
  const status = first && statuses.has(first) ? first : 'attention';
  const argumentMessage = messageFromArguments(
    process.argv.slice(status === first ? 3 : 2)
  );
  const stdinMessage = argumentMessage ? '' : await readStdin();
  const message = summarizeMessage(argumentMessage || stdinMessage);
  const body = JSON.stringify({ sessionId, status, message });

  await new Promise<void>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`Paraterm notification failed: ${response.statusCode}`));
          } else {
            resolve();
          }
        });
      }
    );
    req.once('error', reject);
    req.end(body);
  });
}

function messageFromArguments(values: readonly string[]): string {
  if (values.length > 1 && isJsonObject(values.at(-1))) {
    return values.slice(0, -1).join(' ').trim();
  }
  return values.join(' ').trim();
}

function isJsonObject(value: string | undefined): boolean {
  if (!value?.trim().startsWith('{')) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function summarizeMessage(input: string): string {
  if (!input) {
    return 'Agent needs attention';
  }
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['message', 'notification', 'hook_event_name', 'type']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) {
          return value.slice(0, 240);
        }
      }
    }
  } catch {
    // Plain-text hook messages are valid.
  }
  return input.replace(/\s+/g, ' ').slice(0, 240);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

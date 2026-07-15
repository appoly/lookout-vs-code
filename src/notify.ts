import { request } from 'node:http';
import {
  normalizeProviderEvent,
  type ProviderEventAction,
  type ProviderHook
} from './providerEventNormalization';

type EventStatus = 'running' | 'attention' | 'completed' | 'failed';
type EventAction = ProviderEventAction;
type HookProvider = ProviderHook;

const statuses = new Set<EventStatus>([
  'running',
  'attention',
  'completed',
  'failed'
]);
const actions = new Set<EventAction>([
  ...statuses,
  'foreground-stop',
  'turn-end',
  'background-start',
  'background-stop',
  'command-start',
  'command-stop',
  'session-start'
]);
const MAX_STDIN_BYTES = 64 * 1024;

async function main(): Promise<void> {
  const parsedArguments = parseArguments(process.argv.slice(2));
  const url = process.env.LOOKOUT_NOTIFY_URL;
  const token = process.env.LOOKOUT_NOTIFY_TOKEN;
  const sessionId = process.env.LOOKOUT_SESSION_ID;
  if (!url || !token || !sessionId) {
    // Outside a Lookout session (someone reused the generated settings file or
    // hook command) the hook must be an inert no-op. A non-zero exit here
    // would be treated by Claude as a BLOCKING hook decision.
    if (parsedArguments.hookProvider === 'codex') {
      process.stdout.write('{}\n');
    }
    return;
  }
  const stdinMessage = parsedArguments.hookProvider ? await readStdin() : '';
  if (stdinMessage === undefined) {
    acknowledge(parsedArguments.hookProvider);
    return;
  }
  const providerPayload = parseRecord(
    parsedArguments.payloadArgument || stdinMessage
  );
  const event = normalizeProviderEvent({
    lookoutSessionId: sessionId,
    action: parsedArguments.action,
    explicitMessage: parsedArguments.message,
    ...(parsedArguments.hookProvider
      ? { provider: parsedArguments.hookProvider }
      : {}),
    ...(providerPayload ? { providerPayload } : {}),
    captureCommandOutput:
      process.env.LOOKOUT_CAPTURE_COMMAND_OUTPUT === '1'
  });

  // PreToolUse/PostToolUse can fire for unrelated tools when a matcher lets
  // them through. Shell commands and allow-listed MCP identifiers normalize to
  // a safe label; everything else is acknowledged and dropped quietly.
  if (
    (event.kind === 'command-start' || event.kind === 'command-stop') &&
    !event.command
  ) {
    if (parsedArguments.hookProvider === 'codex') {
      process.stdout.write('{}\n');
    }
    return;
  }

  const body = JSON.stringify(event);

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
            reject(new Error(`Lookout notification failed: ${response.statusCode}`));
          } else {
            resolve();
          }
        });
      }
    );
    req.once('error', reject);
    // A stale endpoint that accepts but never answers must not stall the
    // agent's hook budget (Claude allows ~60s per hook; Codex 10s).
    req.setTimeout(3_000, () => {
      req.destroy(new Error('Lookout notification timed out'));
    });
    req.end(body);
  }).catch((error: unknown) => {
    if (!parsedArguments.hookProvider) {
      throw error;
    }
  });
  acknowledge(parsedArguments.hookProvider);
}

interface ParsedArguments {
  readonly action: EventAction;
  readonly hookProvider?: HookProvider;
  readonly message: string;
  readonly payloadArgument: string;
}

function parseArguments(values: readonly string[]): ParsedArguments {
  const remaining = [...values];
  let hookProvider: HookProvider | undefined;
  const hookIndex = remaining.indexOf('--hook');
  if (hookIndex >= 0) {
    const candidate = remaining[hookIndex + 1];
    if (candidate === 'claude' || candidate === 'codex') {
      hookProvider = candidate;
      remaining.splice(hookIndex, 2);
    }
  }
  const first = remaining.shift() as EventAction | undefined;
  const action = first && actions.has(first) ? first : 'attention';
  if (first && action === 'attention' && first !== 'attention') {
    remaining.unshift(first);
  }
  const payloadArgument = isJsonObject(remaining.at(-1))
    ? (remaining.pop() ?? '')
    : '';
  return {
    action,
    ...(hookProvider ? { hookProvider } : {}),
    message: remaining.join(' ').trim(),
    payloadArgument
  };
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

function parseRecord(input: string): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function acknowledge(provider: HookProvider | undefined): void {
  if (provider === 'codex') {
    process.stdout.write('{}\n');
  }
}

void main().catch(() => {
  const values = process.argv.slice(2);
  const hookIndex = values.indexOf('--hook');
  const candidate = hookIndex >= 0 ? values[hookIndex + 1] : undefined;
  const provider =
    candidate === 'codex' || candidate === 'claude'
      ? candidate
      : undefined;
  if (provider) {
    acknowledge(provider);
    return;
  }
  process.stderr.write('Lookout notification failed\n');
  process.exitCode = 1;
});

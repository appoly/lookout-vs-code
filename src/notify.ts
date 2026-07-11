import { request } from 'node:http';

type EventStatus = 'running' | 'attention' | 'completed' | 'failed';
type EventAction =
  | EventStatus
  | 'foreground-stop'
  | 'turn-end'
  | 'background-start'
  | 'background-stop'
  | 'command-start'
  | 'command-stop';
type HookProvider = 'claude' | 'codex';

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
  'command-stop'
]);

async function main(): Promise<void> {
  const url = process.env.LOOKOUT_NOTIFY_URL;
  const token = process.env.LOOKOUT_NOTIFY_TOKEN;
  const sessionId = process.env.LOOKOUT_SESSION_ID;
  if (!url || !token || !sessionId) {
    process.exitCode = 2;
    return;
  }

  const parsedArguments = parseArguments(process.argv.slice(2));
  const stdinMessage = parsedArguments.hookProvider ? await readStdin() : '';
  const providerPayload = parseRecord(
    parsedArguments.payloadArgument || stdinMessage
  );
  const body = JSON.stringify(
    normalizeEvent(
      sessionId,
      parsedArguments.action,
      parsedArguments.message,
      providerPayload
    )
  );

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
    req.end(body);
  });
  if (parsedArguments.hookProvider === 'codex') {
    process.stdout.write('{}\n');
  }
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

function normalizeEvent(
  sessionId: string,
  action: EventAction,
  explicitMessage: string,
  providerPayload: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (action === 'turn-end') {
    return {
      kind: 'foreground-stop',
      sessionId,
      reason: 'turn-end',
      message: explicitMessage || 'Agent finished'
    };
  }
  if (action === 'foreground-stop') {
    return {
      kind: action,
      sessionId,
      message: explicitMessage || 'Agent is waiting for input'
    };
  }
  if (action === 'background-start' || action === 'background-stop') {
    return {
      kind: action,
      sessionId,
      agentId: providerString(providerPayload, ['agent_id', 'agentId']) ||
        providerString(providerPayload, ['task_id', 'taskId']) ||
        'unknown-agent',
      agentLabel:
        providerString(providerPayload, ['agent_type', 'agentType', 'name']) ||
        explicitMessage ||
        'Delegated agent'
    };
  }
  if (action === 'command-start' || action === 'command-stop') {
    const command = commandFromPayload(providerPayload) || explicitMessage;
    return {
      kind: action,
      sessionId,
      commandId:
        providerString(providerPayload, [
          'tool_use_id',
          'toolUseId',
          'call_id',
          'callId'
        ]) || command,
      command
    };
  }
  return {
    kind: 'status',
    sessionId,
    status: action,
    message: explicitMessage || summarizePayload(providerPayload)
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

function summarizePayload(input: Record<string, unknown> | undefined): string {
  if (!input) {
    return 'Agent needs attention';
  }
  for (const key of ['message', 'notification', 'hook_event_name', 'type']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.replace(/\s+/g, ' ').slice(0, 240);
    }
  }
  return 'Agent needs attention';
}

function commandFromPayload(
  payload: Record<string, unknown> | undefined
): string {
  // Claude Bash-tool hooks nest the command under tool_input.command; some
  // shapes surface it at the top level. Prefer the nested form.
  const toolInput = payload?.tool_input ?? payload?.toolInput;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const nested = providerString(toolInput as Record<string, unknown>, [
      'command'
    ]);
    if (nested) {
      return nested;
    }
  }
  return providerString(payload, ['command']);
}

function providerString(
  payload: Record<string, unknown> | undefined,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.length > 0) {
      return value.slice(0, 200);
    }
  }
  return '';
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

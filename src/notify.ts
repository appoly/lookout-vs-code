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
const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024;

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
  const providerPayload = parseRecord(
    parsedArguments.payloadArgument || stdinMessage
  );
  const event = normalizeEvent(
    sessionId,
    parsedArguments.action,
    parsedArguments.message,
    providerPayload,
    process.env.LOOKOUT_CAPTURE_COMMAND_OUTPUT === '1'
  );

  // PreToolUse/PostToolUse can fire for tools other than the shell (apply_patch,
  // Edit, MCP calls) when a matcher lets them through. Those carry no command,
  // so there is nothing to surface — acknowledge the hook and exit quietly.
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
  providerPayload: Record<string, unknown> | undefined,
  captureCommandOutput: boolean
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
      command,
      ...(action === 'command-stop' && captureCommandOutput
        ? { result: commandResultFromPayload(providerPayload) }
        : {})
    };
  }
  return {
    kind: 'status',
    sessionId,
    status: action,
    message: explicitMessage || summarizePayload(providerPayload)
  };
}

function commandResultFromPayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  const response = payload?.tool_response ?? payload?.toolResponse;
  const responseRecord = isRecord(response) ? response : undefined;
  const error = providerString(payload, ['error']);
  const stdout = responseText(responseRecord, ['stdout', 'output']) ||
    (typeof response === 'string' ? response : '');
  const stderr = responseText(responseRecord, ['stderr']);
  const exitCode = providerNumber(responseRecord, ['exit_code', 'exitCode']) ??
    providerNumber(payload, ['exit_code', 'exitCode']);
  const interrupted = responseRecord?.interrupted === true || payload?.is_interrupt === true;
  const bounded = boundOutput(stdout, stderr);
  return {
    outcome: interrupted ? 'interrupted' : error || (exitCode !== undefined && exitCode !== 0) ? 'failed' : 'completed',
    ...(typeof payload?.duration_ms === 'number' ? { durationMs: payload.duration_ms } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(bounded.stdout ? { stdout: bounded.stdout } : {}),
    ...(bounded.stderr ? { stderr: bounded.stderr } : {}),
    ...(error ? { error } : {}),
    ...(bounded.truncated ? { truncated: true } : {})
  };
}

function responseText(
  response: Record<string, unknown> | undefined,
  keys: readonly string[]
): string {
  for (const key of keys) {
    const value = response?.[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function providerNumber(
  payload: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function boundOutput(stdout: string, stderr: string): {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
} {
  const cleanStdout = sanitizeOutput(stdout);
  const cleanStderr = sanitizeOutput(stderr);
  const hasBoth = cleanStdout.length > 0 && cleanStderr.length > 0;
  const stdoutLimit = hasBoth ? MAX_CAPTURED_OUTPUT_BYTES / 2 : MAX_CAPTURED_OUTPUT_BYTES;
  const stderrLimit = hasBoth ? MAX_CAPTURED_OUTPUT_BYTES / 2 : MAX_CAPTURED_OUTPUT_BYTES;
  const boundedStdout = tailBytes(cleanStdout, stdoutLimit);
  const boundedStderr = tailBytes(cleanStderr, stderrLimit);
  return {
    stdout: boundedStdout.value,
    stderr: boundedStderr.value,
    truncated: boundedStdout.truncated || boundedStderr.truncated
  };
}

function sanitizeOutput(value: string): string {
  const ansiSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replace(ansiSequence, '').replace(/\0/g, '');
}

function tailBytes(value: string, limit: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value) <= limit) {
    return { value, truncated: false };
  }
  const marker = '… output truncated …\n';
  const contentLimit = limit - Buffer.byteLength(marker);
  let start = value.length;
  let size = 0;
  while (start > 0) {
    const codePoint = value.codePointAt(start - 1) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const nextStart = start - width;
    const nextSize = size + Buffer.byteLength(value.slice(nextStart, start));
    if (nextSize > contentLimit) {
      break;
    }
    start = nextStart;
    size = nextSize;
  }
  return { value: `${marker}${value.slice(start)}`, truncated: true };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

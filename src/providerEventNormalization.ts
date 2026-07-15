export type ProviderHook = 'claude' | 'codex';

export type ProviderEventAction =
  | 'running'
  | 'attention'
  | 'completed'
  | 'failed'
  | 'foreground-stop'
  | 'turn-end'
  | 'background-start'
  | 'background-stop'
  | 'command-start'
  | 'command-stop'
  | 'session-start';

export interface ProviderIdentity {
  readonly provider: ProviderHook;
  readonly sessionId: string;
  readonly source?: 'startup' | 'resume' | 'clear' | 'compact';
}

export interface NormalizeProviderEventOptions {
  readonly lookoutSessionId: string;
  readonly action: ProviderEventAction;
  readonly explicitMessage: string;
  readonly provider?: ProviderHook;
  readonly providerPayload?: Record<string, unknown>;
  readonly captureCommandOutput: boolean;
}

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024;

/**
 * Convert provider hook input into Lookout's small bridge protocol.
 *
 * This is intentionally an allow-list. In particular, transcript_path,
 * prompt, last_assistant_message, and fields added by future provider releases
 * are never copied into the result.
 */
export function normalizeProviderEvent(
  options: NormalizeProviderEventOptions
): Record<string, unknown> {
  const {
    lookoutSessionId: sessionId,
    action,
    explicitMessage,
    providerPayload,
    captureCommandOutput
  } = options;
  const providerIdentity = identityFromPayload(options.provider, providerPayload);
  // Keep the provider-owned ID flat and explicitly separate from sessionId,
  // which is Lookout's own routing identifier.
  const identity = providerIdentity
    ? {
        provider: providerIdentity.provider,
        providerSessionId: providerIdentity.sessionId,
        ...(providerIdentity.source
          ? { providerSessionSource: providerIdentity.source }
          : {})
      }
    : {};

  if (action === 'session-start') {
    return { kind: 'provider-session', sessionId, ...identity };
  }
  if (action === 'turn-end') {
    return {
      kind: 'foreground-stop',
      sessionId,
      reason: 'turn-end',
      message: explicitMessage || 'Agent finished',
      ...identity
    };
  }
  if (action === 'foreground-stop') {
    return {
      kind: action,
      sessionId,
      message: explicitMessage || 'Agent is waiting for input',
      ...identity
    };
  }
  if (action === 'background-start' || action === 'background-stop') {
    return {
      kind: action,
      sessionId,
      agentId:
        providerString(providerPayload, ['agent_id', 'agentId']) ||
        providerString(providerPayload, ['task_id', 'taskId']) ||
        'unknown-agent',
      agentLabel:
        providerString(providerPayload, ['agent_type', 'agentType', 'name']) ||
        explicitMessage ||
        'Delegated agent',
      ...identity
    };
  }
  if (action === 'command-start' || action === 'command-stop') {
    const shellCommand = commandFromPayload(providerPayload);
    const toolName = providerString(providerPayload, ['tool_name', 'toolName']);
    const mcpTool = isMcpToolName(toolName) ? toolName : '';
    const command = shellCommand || mcpTool || explicitMessage;
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
      ...(mcpTool && !shellCommand ? { activityKind: 'mcp' } : {}),
      ...(action === 'command-stop' && captureCommandOutput && shellCommand
        ? { result: commandResultFromPayload(providerPayload) }
        : {}),
      ...identity
    };
  }
  return {
    kind: 'status',
    sessionId,
    status: action,
    message: explicitMessage || safeStatusMessage(action),
    ...identity
  };
}

function identityFromPayload(
  provider: ProviderHook | undefined,
  payload: Record<string, unknown> | undefined
): ProviderIdentity | undefined {
  if (!provider) {
    return undefined;
  }
  const sessionId = providerString(payload, ['session_id', 'sessionId']);
  if (!sessionId) {
    return undefined;
  }
  const source = providerString(payload, ['source']);
  return {
    provider,
    sessionId,
    ...(isProviderSessionSource(source) ? { source } : {})
  };
}

function isProviderSessionSource(
  value: string
): value is ProviderIdentity['source'] & string {
  return ['startup', 'resume', 'clear', 'compact'].includes(value);
}

function safeStatusMessage(
  action: 'running' | 'attention' | 'completed' | 'failed'
): string {
  switch (action) {
    case 'running':
      return 'Agent is working';
    case 'completed':
      return 'Agent completed';
    case 'failed':
      return 'Agent failed';
    case 'attention':
      return 'Agent needs attention';
  }
}

function commandResultFromPayload(
  payload: Record<string, unknown> | undefined
): Record<string, unknown> {
  const response = payload?.tool_response ?? payload?.toolResponse;
  const responseRecord = isRecord(response) ? response : undefined;
  const error = providerString(payload, ['error']);
  const stdout =
    responseText(responseRecord, ['stdout', 'output']) ||
    (typeof response === 'string' ? response : '');
  const stderr = responseText(responseRecord, ['stderr']);
  const exitCode =
    providerNumber(responseRecord, ['exit_code', 'exitCode']) ??
    providerNumber(payload, ['exit_code', 'exitCode']);
  const interrupted =
    responseRecord?.interrupted === true || payload?.is_interrupt === true;
  const bounded = boundOutput(stdout, stderr);
  return {
    outcome: interrupted
      ? 'interrupted'
      : error || (exitCode !== undefined && exitCode !== 0)
        ? 'failed'
        : 'completed',
    ...(typeof payload?.duration_ms === 'number'
      ? { durationMs: payload.duration_ms }
      : {}),
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

function boundOutput(
  stdout: string,
  stderr: string
): { readonly stdout: string; readonly stderr: string; readonly truncated: boolean } {
  const cleanStdout = sanitizeOutput(stdout);
  const cleanStderr = sanitizeOutput(stderr);
  const hasBoth = cleanStdout.length > 0 && cleanStderr.length > 0;
  const stdoutLimit = hasBoth
    ? MAX_CAPTURED_OUTPUT_BYTES / 2
    : MAX_CAPTURED_OUTPUT_BYTES;
  const stderrLimit = hasBoth
    ? MAX_CAPTURED_OUTPUT_BYTES / 2
    : MAX_CAPTURED_OUTPUT_BYTES;
  const boundedStdout = tailBytes(cleanStdout, stdoutLimit);
  const boundedStderr = tailBytes(cleanStderr, stderrLimit);
  return {
    stdout: boundedStdout.value,
    stderr: boundedStderr.value,
    truncated: boundedStdout.truncated || boundedStderr.truncated
  };
}

function sanitizeOutput(value: string): string {
  const ansiSequence = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'g'
  );
  return value.replace(ansiSequence, '').replace(/\0/g, '');
}

function tailBytes(
  value: string,
  limit: number
): { readonly value: string; readonly truncated: boolean } {
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

function commandFromPayload(
  payload: Record<string, unknown> | undefined
): string {
  const toolInput = payload?.tool_input ?? payload?.toolInput;
  if (isRecord(toolInput)) {
    const nested = providerString(toolInput, ['command']);
    if (nested) {
      return nested;
    }
  }
  return providerString(payload, ['command']);
}

function isMcpToolName(value: string): boolean {
  return value.startsWith('codex_apps.') || value.startsWith('mcp__');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

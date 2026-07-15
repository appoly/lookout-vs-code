import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AgentEvent,
  AgentReportedStatus,
  CommandResult,
  DelegatedAgentTokenUsage,
  SessionTokenUsage
} from './types';
import type { UsageBridgeEvent, UsageWindow } from './usageTypes';

const EVENT_STATUSES = new Set<AgentReportedStatus>([
  'running',
  'attention',
  'completed',
  'failed'
]);
const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface AttentionEndpoint {
  readonly url: string;
  readonly token: string;
}

export class AttentionServer {
  private server: Server | undefined;
  private endpointValue: AttentionEndpoint | undefined;
  private token = createToken();

  public constructor(
    private readonly onEvent: (event: AgentEvent) => void,
    private readonly onUsage: (event: UsageBridgeEvent) => void
  ) {}

  public get endpoint(): AttentionEndpoint {
    if (!this.endpointValue) {
      throw new Error('Attention server has not started');
    }
    return this.endpointValue;
  }

  public async start(preferred?: AttentionEndpoint): Promise<AttentionEndpoint> {
    if (this.endpointValue) {
      return this.endpointValue;
    }

    let preferredPort = 0;
    if (preferred && isReusableEndpoint(preferred)) {
      preferredPort = Number(new URL(preferred.url).port);
      this.token = preferred.token;
    }

    try {
      await this.listen(preferredPort);
    } catch (error) {
      if (!preferredPort) {
        throw error;
      }
      this.server?.close();
      this.server = undefined;
      this.token = createToken();
      await this.listen(0);
    }

    const address = this.server?.address() as AddressInfo;
    this.endpointValue = {
      url: `http://127.0.0.1:${address.port}/events`,
      token: this.token
    };
    return this.endpointValue;
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.endpointValue = undefined;
  }

  private async listen(port: number): Promise<void> {
    this.server = createServer((request, response) => {
      if (
        request.method !== 'POST' ||
        (request.url !== '/events' && request.url !== '/usage') ||
        !tokenMatches(request.headers.authorization, this.token)
      ) {
        response.writeHead(404).end();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let rejected = false;
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy());
      request.on('data', (chunk: Buffer) => {
        if (rejected) {
          return;
        }
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          rejected = true;
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        if (rejected) {
          return;
        }
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (request.url === '/usage') {
            this.onUsage(parseUsageEvent(value));
          } else {
            this.onEvent(parseAgentEvent(value));
          }
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    this.server.headersTimeout = REQUEST_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => resolve());
    });
    // The pre-listen handler above is consumed by its first use; without a
    // persistent handler a later runtime 'error' would crash the host.
    this.server?.on('error', () => undefined);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(header ?? '');
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

function parseAgentEvent(value: unknown): AgentEvent {
  if (!isRecord(value)) {
    throw new Error('Event must be an object');
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new Error('Event requires a session ID');
  }
  const provider = parseProviderMetadata(value);
  if (value.kind === 'provider-session') {
    if (!provider.provider || !provider.providerSessionId) {
      throw new Error('Provider session event requires provider identity');
    }
    return {
      kind: 'provider-session',
      sessionId: value.sessionId,
      provider: provider.provider,
      providerSessionId: provider.providerSessionId,
      ...(provider.providerSessionSource
        ? { providerSessionSource: provider.providerSessionSource }
        : {})
    };
  }
  if (value.kind === 'foreground-stop') {
    return {
      kind: 'foreground-stop',
      sessionId: value.sessionId,
      ...provider,
      ...(value.reason === 'turn-end' ? { reason: 'turn-end' as const } : {}),
      ...(typeof value.message === 'string'
        ? { message: value.message.slice(0, 240) }
        : {})
    };
  }
  if (value.kind === 'background-start' || value.kind === 'background-stop') {
    if (typeof value.agentId !== 'string' || value.agentId.length === 0) {
      throw new Error('Background event requires an agent ID');
    }
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      ...provider,
      agentId: value.agentId.slice(0, 200),
      agentLabel:
        typeof value.agentLabel === 'string' && value.agentLabel.length > 0
          ? value.agentLabel.slice(0, 120)
          : 'Delegated agent'
    };
  }
  if (value.kind === 'command-start' || value.kind === 'command-stop') {
    if (typeof value.command !== 'string' || value.command.length === 0) {
      throw new Error('Command event requires a command');
    }
    const command = value.command.replace(/\s+/g, ' ').trim().slice(0, 200);
    const commandId =
      typeof value.commandId === 'string' && value.commandId.length > 0
        ? value.commandId.slice(0, 200)
        : command;
    const result =
      value.kind === 'command-stop' ? parseCommandResult(value.result) : undefined;
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      ...provider,
      commandId,
      command,
      ...(value.activityKind === 'mcp' ? { activityKind: 'mcp' as const } : {}),
      ...(result ? { result } : {})
    };
  }
  if (
    typeof value.status !== 'string' ||
    !EVENT_STATUSES.has(value.status as AgentReportedStatus)
  ) {
    throw new Error('Event has an invalid status');
  }
  return {
    kind: 'status',
    sessionId: value.sessionId,
    ...provider,
    status: value.status as AgentReportedStatus,
    ...(typeof value.message === 'string' ? { message: value.message.slice(0, 240) } : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {})
  };
}

function parseCommandResult(value: unknown):
  | Omit<CommandResult, 'id' | 'command' | 'completedAt'>
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.outcome !== 'completed' &&
    value.outcome !== 'failed' &&
    value.outcome !== 'interrupted'
  ) {
    return undefined;
  }
  const stdout = boundedOutput(value.stdout);
  const stderr = boundedOutput(value.stderr);
  const error = boundedOutput(value.error, 240);
  return {
    outcome: value.outcome,
    ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? { durationMs: Math.max(0, Math.floor(value.durationMs)) }
      : {}),
    ...(typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)
      ? { exitCode: Math.floor(value.exitCode) }
      : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(error ? { error } : {}),
    ...(value.truncated === true ? { truncated: true } : {})
  };
}

function parseProviderMetadata(
  value: Record<string, unknown>
): Pick<
  AgentEvent,
  'provider' | 'providerSessionId' | 'providerSessionSource'
> {
  const provider =
    value.provider === 'codex' || value.provider === 'claude'
      ? value.provider
      : undefined;
  const providerSessionId =
    typeof value.providerSessionId === 'string' &&
    value.providerSessionId.length > 0 &&
    value.providerSessionId.length <= 200
      ? value.providerSessionId
      : undefined;
  const source = value.providerSessionSource;
  const providerSessionSource =
    source === 'startup' ||
    source === 'resume' ||
    source === 'clear' ||
    source === 'compact'
      ? source
      : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(providerSessionId ? { providerSessionId } : {}),
    ...(providerSessionSource ? { providerSessionSource } : {})
  };
}

function boundedOutput(value: unknown, maximum = 8 * 1024): string | undefined {
  return typeof value === 'string' && Buffer.byteLength(value) <= maximum
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUsageEvent(value: unknown): UsageBridgeEvent {
  if (!isRecord(value) || value.provider !== 'claude') {
    throw new Error('Invalid usage event');
  }
  const observedAt = sanitizeObservedAt(value.observedAt);
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.length > 0
      ? value.sessionId.slice(0, 200)
      : undefined;
  if (value.kind === 'delegated-agents') {
    if (!sessionId || !Array.isArray(value.delegatedAgents)) {
      throw new Error('Invalid delegated usage event');
    }
    if (value.delegatedAgents.length > 64) {
      throw new Error('Too many delegated agents');
    }
    return {
      kind: 'delegated-agents',
      provider: 'claude',
      observedAt,
      sessionId,
      delegatedAgents: value.delegatedAgents.flatMap(parseDelegatedTokenUsage)
    };
  }
  if (
    (value.kind !== undefined && value.kind !== 'snapshot') ||
    !Array.isArray(value.windows)
  ) {
    throw new Error('Invalid usage event');
  }
  if (value.windows.length > 16) {
    throw new Error('Too many usage windows');
  }
  const windows = value.windows.map(parseUsageWindow);
  const tokenUsage = parseSessionTokenUsage(value.tokenUsage);
  return {
    provider: 'claude',
    observedAt,
    windows,
    ...(sessionId ? { sessionId } : {}),
    ...(tokenUsage ? { tokenUsage } : {})
  };
}

function parseSessionTokenUsage(value: unknown): SessionTokenUsage | undefined {
  if (
    !isRecord(value) ||
    value.source !== 'claude-statusline' ||
    typeof value.contextTokens !== 'number' ||
    typeof value.inputTokens !== 'number' ||
    typeof value.outputTokens !== 'number' ||
    !Number.isFinite(value.contextTokens) ||
    !Number.isFinite(value.inputTokens) ||
    !Number.isFinite(value.outputTokens)
  ) {
    return undefined;
  }
  const delegatedAgents = Array.isArray(value.delegatedAgents)
    ? value.delegatedAgents.slice(0, 64).flatMap(parseDelegatedTokenUsage)
    : [];
  return {
    source: 'claude-statusline',
    observedAt: sanitizeObservedAt(value.observedAt),
    contextTokens: boundedCount(value.contextTokens),
    inputTokens: boundedCount(value.inputTokens),
    outputTokens: boundedCount(value.outputTokens),
    ...(typeof value.contextWindowTokens === 'number' &&
    Number.isFinite(value.contextWindowTokens)
      ? { contextWindowTokens: boundedCount(value.contextWindowTokens) }
      : {}),
    ...(typeof value.contextUsedPercent === 'number' &&
    Number.isFinite(value.contextUsedPercent)
      ? {
          contextUsedPercent: Math.max(
            0,
            Math.min(100, value.contextUsedPercent)
          )
        }
      : {}),
    ...(typeof value.totalCostUsd === 'number' && Number.isFinite(value.totalCostUsd)
      ? { totalCostUsd: Math.max(0, value.totalCostUsd) }
      : {}),
    delegatedAgents
  };
}

function parseDelegatedTokenUsage(value: unknown): DelegatedAgentTokenUsage[] {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.label !== 'string' ||
    value.label.length === 0 ||
    typeof value.tokenCount !== 'number' ||
    !Number.isFinite(value.tokenCount)
  ) {
    return [];
  }
  return [{
    id: value.id.slice(0, 200),
    label: value.label.slice(0, 120),
    tokenCount: boundedCount(value.tokenCount),
    ...(typeof value.status === 'string'
      ? { status: value.status.slice(0, 40) }
      : {})
  }];
}

function boundedCount(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;
}

function sanitizeObservedAt(value: unknown): number {
  const now = Date.now();
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(now + 5 * 60_000, Math.floor(value)))
    : now;
}

function parseUsageWindow(value: unknown): UsageWindow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.usedPercent !== 'number' ||
    !Number.isFinite(value.usedPercent)
  ) {
    throw new Error('Invalid usage window');
  }
  return {
    id: value.id.slice(0, 80),
    label: value.label.slice(0, 80),
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    ...(typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
      ? { resetsAt: boundedCount(value.resetsAt) }
      : {}),
    ...(typeof value.windowMinutes === 'number' && Number.isFinite(value.windowMinutes)
      ? { windowMinutes: boundedCount(value.windowMinutes) }
      : {})
  };
}

function createToken(): string {
  return randomBytes(24).toString('hex');
}

function isReusableEndpoint(endpoint: AttentionEndpoint): boolean {
  try {
    const url = new URL(endpoint.url);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number.isInteger(Number(url.port)) &&
      Number(url.port) > 0 &&
      /^[a-f0-9]{48}$/.test(endpoint.token)
    );
  } catch {
    return false;
  }
}

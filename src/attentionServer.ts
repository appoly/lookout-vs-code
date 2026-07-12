import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentEvent, AgentReportedStatus } from './types';
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
  if (value.kind === 'foreground-stop') {
    return {
      kind: 'foreground-stop',
      sessionId: value.sessionId,
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
    return {
      kind: value.kind,
      sessionId: value.sessionId,
      commandId,
      command
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
    status: value.status as AgentReportedStatus,
    ...(typeof value.message === 'string' ? { message: value.message.slice(0, 240) } : {}),
    ...(typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUsageEvent(value: unknown): UsageBridgeEvent {
  if (!isRecord(value) || value.provider !== 'claude' || !Array.isArray(value.windows)) {
    throw new Error('Invalid usage event');
  }
  if (value.windows.length > 16) {
    throw new Error('Too many usage windows');
  }
  const windows = value.windows.map(parseUsageWindow);
  return {
    provider: 'claude',
    observedAt: typeof value.observedAt === 'number' ? value.observedAt : Date.now(),
    windows
  };
}

function parseUsageWindow(value: unknown): UsageWindow {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.usedPercent !== 'number'
  ) {
    throw new Error('Invalid usage window');
  }
  return {
    id: value.id.slice(0, 80),
    label: value.label.slice(0, 80),
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    ...(typeof value.resetsAt === 'number' ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowMinutes === 'number' ? { windowMinutes: value.windowMinutes } : {})
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

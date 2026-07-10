import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentEvent, SessionStatus } from './types';
import type { UsageBridgeEvent, UsageWindow } from './usageTypes';

const EVENT_STATUSES = new Set<SessionStatus>([
  'running',
  'attention',
  'completed',
  'failed'
]);

export interface AttentionEndpoint {
  readonly url: string;
  readonly token: string;
}

export class AttentionServer {
  private server: Server | undefined;
  private endpointValue: AttentionEndpoint | undefined;
  private readonly token = randomBytes(24).toString('hex');

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

  public async start(): Promise<AttentionEndpoint> {
    if (this.endpointValue) {
      return this.endpointValue;
    }

    this.server = createServer((request, response) => {
      if (
        request.method !== 'POST' ||
        (request.url !== '/events' && request.url !== '/usage') ||
        request.headers.authorization !== `Bearer ${this.token}`
      ) {
        response.writeHead(404).end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
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

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address() as AddressInfo;
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
}

function parseAgentEvent(value: unknown): AgentEvent {
  if (!isRecord(value)) {
    throw new Error('Event must be an object');
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length === 0) {
    throw new Error('Event requires a session ID');
  }
  if (typeof value.status !== 'string' || !EVENT_STATUSES.has(value.status as SessionStatus)) {
    throw new Error('Event has an invalid status');
  }
  return {
    sessionId: value.sessionId,
    status: value.status as AgentEvent['status'],
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
    id: value.id,
    label: value.label,
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    ...(typeof value.resetsAt === 'number' ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowMinutes === 'number' ? { windowMinutes: value.windowMinutes } : {})
  };
}

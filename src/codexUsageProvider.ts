import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { UsageSnapshot, UsageWindow } from './usageTypes';

interface RpcResponse {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface RateLimitWindowPayload {
  readonly usedPercent?: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
}

interface RateLimitSnapshotPayload {
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly planType?: string | null;
  readonly primary?: RateLimitWindowPayload | null;
  readonly secondary?: RateLimitWindowPayload | null;
  readonly credits?: {
    readonly balance?: string | null;
    readonly unlimited?: boolean;
  } | null;
}

interface RateLimitResponsePayload {
  readonly rateLimits?: RateLimitSnapshotPayload;
  readonly rateLimitsByLimitId?: Record<string, RateLimitSnapshotPayload> | null;
  readonly rateLimitResetCredits?: { readonly availableCount?: number } | null;
}

export class CodexUsageProvider {
  private process: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = '';
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private lastError = '';
  private refreshPromise: Promise<void> | undefined;

  public constructor(
    private readonly executable: string,
    private readonly onSnapshot: (snapshot: UsageSnapshot) => void,
    private includeSparkLimits = false
  ) {}

  public setIncludeSparkLimits(include: boolean): void {
    this.includeSparkLimits = include;
  }

  public async start(): Promise<void> {
    if (this.process) {
      return;
    }
    this.onSnapshot(waitingSnapshot('Starting Codex usage service…'));
    this.stdoutBuffer = '';
    this.lastError = '';
    try {
      const child = spawn(this.executable, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      this.process = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.handleOutput(chunk));
      child.stderr.on('data', (chunk: string) => {
        this.lastError = `${this.lastError}${chunk}`.slice(-1000);
      });
      child.once('error', (error) => this.handleProcessError(error));
      child.once('exit', (code) => {
        if (this.process === child) {
          this.process = undefined;
          this.initialized = false;
          this.rejectPending(new Error(`Codex app-server exited (${code ?? 'unknown'})`));
          this.onSnapshot(
            errorSnapshot(cleanError(this.lastError) || 'Codex usage service stopped')
          );
        }
      });

      await this.request('initialize', {
        clientInfo: {
          name: 'multi-term-vscode',
          title: 'Paraterm Agent Cockpit',
          version: '0.1.0'
        },
        capabilities: { experimentalApi: false }
      });
      this.send({ method: 'initialized' });
      this.initialized = true;
      await this.readRateLimits();
    } catch (error) {
      this.handleProcessError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  public refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const operation = this.performRefresh().finally(() => {
      if (this.refreshPromise === operation) {
        this.refreshPromise = undefined;
      }
    });
    this.refreshPromise = operation;
    return operation;
  }

  private async performRefresh(): Promise<void> {
    if (!this.process) {
      await this.start();
      return;
    }
    if (!this.initialized) {
      return;
    }
    await this.readRateLimits();
  }

  private async readRateLimits(): Promise<void> {
    try {
      const result = (await this.request(
        'account/rateLimits/read',
        null
      )) as RateLimitResponsePayload;
      this.onSnapshot(
        normalizeRateLimits(result, {
          includeSparkLimits: this.includeSparkLimits
        })
      );
    } catch (error) {
      this.onSnapshot(codexErrorSnapshot(error));
    }
  }

  public dispose(): void {
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    this.rejectPending(new Error('Codex usage provider disposed'));
    child?.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(value: object): void {
    if (!this.process?.stdin.writable) {
      throw new Error('Codex app-server is not available');
    }
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleOutput(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleMessage(line);
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (message.method === 'account/rateLimits/updated') {
      void this.refresh();
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? 'Codex request failed'));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleProcessError(error: Error): void {
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    this.rejectPending(error);
    child?.kill();
    const unsupported = error.message.includes('ENOENT');
    this.onSnapshot({
      provider: 'codex',
      status: unsupported ? 'unsupported' : 'error',
      observedAt: Date.now(),
      source: 'codex-app-server',
      windows: [],
      detail: unsupported ? 'Codex CLI was not found' : cleanError(error.message)
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function normalizeRateLimits(
  payload: RateLimitResponsePayload,
  options: { readonly includeSparkLimits?: boolean } = {}
): UsageSnapshot {
  const allEntries = payload.rateLimitsByLimitId
    ? Object.entries(payload.rateLimitsByLimitId)
    : payload.rateLimits
      ? [[payload.rateLimits.limitId ?? 'codex', payload.rateLimits] as const]
      : [];
  const entries = allEntries.filter(
    ([limitId, snapshot]) =>
      options.includeSparkLimits || !isSparkLimit(limitId, snapshot)
  );
  const windows: UsageWindow[] = [];
  for (const [limitId, snapshot] of entries) {
    const prefix = entries.length > 1 ? `${snapshot.limitName ?? limitId} ` : '';
    appendWindow(windows, `${limitId}:primary`, `${prefix}${windowLabel(snapshot.primary)}`, snapshot.primary);
    appendWindow(
      windows,
      `${limitId}:secondary`,
      `${prefix}${windowLabel(snapshot.secondary)}`,
      snapshot.secondary
    );
  }
  const representative =
    entries[0]?.[1] ?? payload.rateLimits ?? allEntries[0]?.[1];
  return {
    provider: 'codex',
    status:
      windows.length > 0 || allEntries.length > 0
        ? 'available'
        : 'authRequired',
    observedAt: Date.now(),
    source: 'codex-app-server',
    windows,
    ...(representative?.planType ? { plan: representative.planType } : {}),
    ...(representative?.credits || payload.rateLimitResetCredits
      ? {
          credits: {
            ...(representative.credits?.balance
              ? { balance: representative.credits.balance }
              : {}),
            ...(representative.credits?.unlimited !== undefined
              ? { unlimited: representative.credits.unlimited }
              : {}),
            ...(payload.rateLimitResetCredits?.availableCount !== undefined
              ? { resetCount: payload.rateLimitResetCredits.availableCount }
              : {})
          }
        }
      : {}),
    ...(windows.length === 0
      ? {
          detail:
            allEntries.length > 0
              ? 'No enabled Codex limit buckets are available'
              : 'Sign in to Codex to see usage limits'
        }
      : {})
  };
}

function isSparkLimit(
  limitId: string,
  snapshot: RateLimitSnapshotPayload
): boolean {
  return /spark/i.test(`${limitId} ${snapshot.limitName ?? ''}`);
}

function appendWindow(
  target: UsageWindow[],
  id: string,
  label: string,
  value: RateLimitWindowPayload | null | undefined
): void {
  if (!value || typeof value.usedPercent !== 'number') {
    return;
  }
  target.push({
    id,
    label,
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    ...(typeof value.resetsAt === 'number' ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowDurationMins === 'number'
      ? { windowMinutes: value.windowDurationMins }
      : {})
  });
}

function windowLabel(value: RateLimitWindowPayload | null | undefined): string {
  const minutes = value?.windowDurationMins;
  if (!minutes) {
    return 'Usage window';
  }
  if (minutes % 10080 === 0) {
    return `${minutes / 10080} week`;
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440} day`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} hour`;
  }
  return `${minutes} minute`;
}

function waitingSnapshot(detail: string): UsageSnapshot {
  return {
    provider: 'codex',
    status: 'waiting',
    observedAt: Date.now(),
    source: 'codex-app-server',
    windows: [],
    detail
  };
}

function errorSnapshot(detail: string): UsageSnapshot {
  return {
    provider: 'codex',
    status: 'error',
    observedAt: Date.now(),
    source: 'codex-app-server',
    windows: [],
    detail: cleanError(detail)
  };
}

export function codexErrorSnapshot(error: unknown): UsageSnapshot {
  const detail = cleanError(
    error instanceof Error ? error.message : String(error)
  );
  if (
    /(?:not logged in|login required|authentication|unauthorized|\b401\b|no account)/i.test(
      detail
    )
  ) {
    return {
      provider: 'codex',
      status: 'authRequired',
      observedAt: Date.now(),
      source: 'codex-app-server',
      windows: [],
      detail: 'Sign in to Codex to see usage limits'
    };
  }
  return errorSnapshot(detail);
}

function cleanError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

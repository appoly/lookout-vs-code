import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import type { UsageSnapshot, UsageWindow } from './usageTypes';

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const MAX_STDOUT_LINE_LENGTH = 1024 * 1024;

type AppServerSpawner = (
  command: string,
  args: readonly string[],
  viaCmdWrapper: boolean
) => ChildProcessWithoutNullStreams;

interface AppServerLaunchTarget {
  readonly command: string;
  readonly args: string[];
  readonly viaCmdWrapper: boolean;
}

interface AppServerRuntime {
  readonly spawnAppServer?: AppServerSpawner;
  readonly resolveLaunchTarget?: () => Promise<AppServerLaunchTarget>;
}

interface RpcResponse {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

class RpcError extends Error {
  public constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
  }
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
  private startPromise: Promise<void> | undefined;
  private startAttempted = false;
  private processViaCmdWrapper = false;
  private lifecycleGeneration = 0;
  private disposed = false;

  public constructor(
    private readonly executable: string,
    private readonly onSnapshot: (snapshot: UsageSnapshot) => void,
    private includeSparkLimits = false,
    /**
     * Supplies a spawnable path when the extension host PATH cannot resolve
     * the bare executable (e.g. the default terminal shell's rc files added
     * its directory). Undefined means spawn the configured value as-is.
     */
    private readonly resolveExecutableOverride?: (
      executable: string
    ) => Promise<string | undefined>,
    private readonly runtime: AppServerRuntime = {}
  ) {}

  /**
   * Node cannot spawn npm's `.cmd` shims directly (EINVAL since the batch-file
   * CVE fix) and does not search PATH for them, so a bare or shim executable
   * must be resolved with `where.exe` and run through cmd.exe.
   */
  private async resolveLaunchTarget(): Promise<AppServerLaunchTarget> {
    if (this.runtime.resolveLaunchTarget) {
      return this.runtime.resolveLaunchTarget();
    }
    const args = ['app-server', '--stdio'];
    if (process.platform !== 'win32') {
      const override = await this.resolveExecutableOverride?.(this.executable);
      return { command: override ?? this.executable, args, viaCmdWrapper: false };
    }
    let target = this.executable;
    if (!/[\\/]/.test(target) && !/\.(exe|cmd|bat|com)$/i.test(target)) {
      const resolved = await resolveWindowsExecutable(target);
      if (resolved) {
        target = resolved;
      }
    }
    if (/\.(cmd|bat)$/i.test(target)) {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `""${target}" app-server --stdio"`],
        viaCmdWrapper: true
      };
    }
    return { command: target, args, viaCmdWrapper: false };
  }

  private terminate(
    child: ChildProcessWithoutNullStreams,
    viaCmdWrapper: boolean
  ): void {
    // Killing the cmd.exe wrapper alone would orphan the actual app-server;
    // take the whole tree down on Windows.
    if (
      viaCmdWrapper &&
      process.platform === 'win32' &&
      child.pid &&
      child.exitCode === null
    ) {
      try {
        const taskkill = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          {
            stdio: 'ignore',
            windowsHide: true
          }
        );
        taskkill.once('error', () => child.kill());
        return;
      } catch {
        // Fall through to the plain kill below.
      }
    }
    child.kill();
  }

  public setIncludeSparkLimits(include: boolean): void {
    this.includeSparkLimits = include;
  }

  public start(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.process) {
      return Promise.resolve();
    }
    const generation = ++this.lifecycleGeneration;
    // Defer the body by one microtask so a synchronous snapshot callback
    // cannot re-enter start() before startPromise has been installed.
    const operation = Promise.resolve()
      .then(() => this.performStart(generation))
      .finally(() => {
        if (this.startPromise === operation) {
          this.startPromise = undefined;
        }
      });
    this.startPromise = operation;
    return operation;
  }

  private async performStart(generation: number): Promise<void> {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    // Only announce "starting" once: retries after a failed start would
    // otherwise flicker waiting → unsupported on every refresh forever.
    if (!this.startAttempted) {
      this.startAttempted = true;
      this.onSnapshot(waitingSnapshot('Starting Codex usage service…'));
    }
    this.stdoutBuffer = '';
    this.lastError = '';
    let child: ChildProcessWithoutNullStreams | undefined;
    let viaCmdWrapper = false;
    try {
      const target = await this.resolveLaunchTarget();
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      viaCmdWrapper = target.viaCmdWrapper;
      const spawned = (this.runtime.spawnAppServer ?? spawnAppServerProcess)(
        target.command,
        target.args,
        viaCmdWrapper
      );
      child = spawned;
      // A test double or future spawn wrapper may synchronously dispose the
      // provider. Never leave that newly created child untracked.
      if (!this.isCurrentGeneration(generation)) {
        this.terminate(spawned, viaCmdWrapper);
        return;
      }
      this.process = spawned;
      this.processViaCmdWrapper = viaCmdWrapper;
      spawned.stdout.setEncoding('utf8');
      spawned.stderr.setEncoding('utf8');
      spawned.stdout.on('data', (chunk: string) =>
        this.handleOutput(spawned, generation, viaCmdWrapper, chunk)
      );
      spawned.stderr.on('data', (chunk: string) => {
        if (this.isActiveChild(spawned, generation)) {
          this.lastError = `${this.lastError}${chunk}`.slice(-1000);
        }
      });
      spawned.once('error', (error) =>
        this.handleProcessError(error, generation, spawned, viaCmdWrapper)
      );
      spawned.once('exit', (code) => {
        if (this.isActiveChild(spawned, generation)) {
          this.process = undefined;
          this.processViaCmdWrapper = false;
          this.initialized = false;
          this.stdoutBuffer = '';
          this.rejectPending(new Error(`Codex app-server exited (${code ?? 'unknown'})`));
          this.onSnapshot(
            errorSnapshot(cleanError(this.lastError) || 'Codex usage service stopped')
          );
        }
      });

      await this.request('initialize', {
        clientInfo: {
          name: 'lookout-vscode',
          title: 'Lookout for VS Code',
          version: '0.1.0'
        },
        capabilities: { experimentalApi: false }
      });
      if (!this.isActiveChild(spawned, generation)) {
        return;
      }
      this.send({ method: 'initialized' });
      this.initialized = true;
      await this.readRateLimits(spawned, generation);
    } catch (error) {
      if (
        this.isCurrentGeneration(generation) &&
        (!child || this.process === child)
      ) {
        this.handleProcessError(
          error instanceof Error ? error : new Error(String(error)),
          generation,
          child,
          viaCmdWrapper
        );
      }
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
    if (this.disposed) {
      return;
    }
    if (!this.process || this.startPromise) {
      await this.start();
      return;
    }
    if (!this.initialized) {
      return;
    }
    await this.readRateLimits(this.process, this.lifecycleGeneration);
  }

  private async readRateLimits(
    child: ChildProcessWithoutNullStreams,
    generation: number
  ): Promise<void> {
    try {
      const result = (await this.request(
        'account/rateLimits/read',
        null
      )) as RateLimitResponsePayload;
      if (!this.isActiveChild(child, generation)) {
        return;
      }
      this.onSnapshot(
        normalizeRateLimits(result, {
          includeSparkLimits: this.includeSparkLimits
        })
      );
    } catch (error) {
      if (this.isActiveChild(child, generation)) {
        this.onSnapshot(codexErrorSnapshot(error));
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    const child = this.process;
    const viaCmdWrapper = this.processViaCmdWrapper;
    this.process = undefined;
    this.processViaCmdWrapper = false;
    this.initialized = false;
    this.stdoutBuffer = '';
    this.rejectPending(new Error('Codex usage provider disposed'));
    if (child) {
      this.terminate(child, viaCmdWrapper);
    }
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

  private handleOutput(
    child: ChildProcessWithoutNullStreams,
    generation: number,
    viaCmdWrapper: boolean,
    chunk: string
  ): void {
    if (!this.isActiveChild(child, generation)) {
      return;
    }
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      if (newline > MAX_STDOUT_LINE_LENGTH) {
        this.handleProcessError(
          new Error('Codex app-server response exceeded the size limit'),
          generation,
          child,
          viaCmdWrapper
        );
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleMessage(line);
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_LENGTH) {
      this.handleProcessError(
        new Error('Codex app-server response exceeded the size limit'),
        generation,
        child,
        viaCmdWrapper
      );
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
      pending.reject(
        new RpcError(
          message.error.message ?? 'Codex request failed',
          message.error.code
        )
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private handleProcessError(
    error: Error,
    generation: number,
    child: ChildProcessWithoutNullStreams | undefined,
    viaCmdWrapper: boolean
  ): void {
    if (!this.isCurrentGeneration(generation)) {
      return;
    }
    if (child && this.process !== child) {
      return;
    }
    const activeChild = child ?? this.process;
    this.process = undefined;
    this.processViaCmdWrapper = false;
    this.initialized = false;
    this.stdoutBuffer = '';
    this.rejectPending(error);
    if (activeChild) {
      this.terminate(activeChild, viaCmdWrapper);
    }
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

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && this.lifecycleGeneration === generation;
  }

  private isActiveChild(
    child: ChildProcessWithoutNullStreams,
    generation: number
  ): boolean {
    return this.isCurrentGeneration(generation) && this.process === child;
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
  rawPayload: RateLimitResponsePayload | null | undefined,
  options: { readonly includeSparkLimits?: boolean } = {}
): UsageSnapshot {
  const payload = rawPayload ?? {};
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
  const hasCredits = Boolean(
    representative?.credits || payload.rateLimitResetCredits
  );
  // An empty successful response is a schema or account shape Lookout does
  // not understand — report it as such rather than guessing at sign-in state
  // (authentication problems arrive as errors and are classified there).
  const status: UsageSnapshot['status'] =
    windows.length > 0 || allEntries.length > 0 || hasCredits
      ? 'available'
      : 'unsupported';
  return {
    provider: 'codex',
    status,
    observedAt: Date.now(),
    source: 'codex-app-server',
    windows,
    ...(representative?.planType ? { plan: representative.planType } : {}),
    ...(hasCredits
      ? {
          credits: {
            ...(representative?.credits?.balance
              ? { balance: representative.credits.balance }
              : {}),
            ...(representative?.credits?.unlimited !== undefined
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
              : hasCredits
                ? 'No rate-limit windows reported'
                : 'Codex did not report usage limits'
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
    (error instanceof RpcError && error.code === JSON_RPC_METHOD_NOT_FOUND) ||
    /method not found/i.test(detail)
  ) {
    return {
      provider: 'codex',
      status: 'unsupported',
      observedAt: Date.now(),
      source: 'codex-app-server',
      windows: [],
      detail: 'This Codex CLI version does not report usage limits'
    };
  }
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

function spawnAppServerProcess(
  command: string,
  args: readonly string[],
  viaCmdWrapper: boolean
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(viaCmdWrapper ? { windowsVerbatimArguments: true } : {})
  });
}

function resolveWindowsExecutable(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'where.exe',
      [name],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const first = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        resolve(first);
      }
    );
  });
}

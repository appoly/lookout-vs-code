import type * as vscode from 'vscode';
import {
  claimGlobalHistoryIntent,
  createGlobalHistoryIntent,
  deleteGlobalHistoryRecords,
  emptyGlobalHistory,
  globalHistoryRecord,
  normalizeGlobalHistory,
  replaceWorkspaceHistory,
  type GlobalHistoryEnvelope,
  type GlobalHistoryIntent,
  type GlobalHistoryRecord,
  type WorkspaceIdentity
} from './globalHistoryModel';
import type { SessionManager } from './sessionManager';
import { SharedFileStore } from './sharedFileStore';

const GLOBAL_HISTORY_FILE = 'global-history-v1.json';
const POLL_INTERVAL_MS = 4_000;
const SYNC_DEBOUNCE_MS = 150;

export class GlobalHistoryStore {
  private readonly file: SharedFileStore<GlobalHistoryEnvelope>;

  public constructor(globalStoragePath: string) {
    this.file = new SharedFileStore({
      directory: globalStoragePath,
      filename: GLOBAL_HISTORY_FILE,
      empty: emptyGlobalHistory,
      decode: normalizeGlobalHistory
    });
  }

  public initialize(): Promise<void> {
    return this.file.initialize();
  }

  public load(): Promise<GlobalHistoryEnvelope> {
    return this.file.read();
  }

  public replaceWorkspace(
    workspaceKey: string,
    records: readonly GlobalHistoryRecord[],
    now = Date.now()
  ): Promise<GlobalHistoryEnvelope> {
    return this.file.update((current) =>
      replaceWorkspaceHistory(current, workspaceKey, records, now)
    );
  }

  public deleteRecords(
    ids: readonly string[],
    now = Date.now()
  ): Promise<GlobalHistoryEnvelope> {
    return this.file.update((current) =>
      deleteGlobalHistoryRecords(current, ids, now)
    );
  }

  public async createIntent(
    recordId: string,
    operation: GlobalHistoryIntent['operation'],
    now = Date.now()
  ): Promise<{ readonly intent?: GlobalHistoryIntent; readonly record?: GlobalHistoryRecord }> {
    let created: GlobalHistoryIntent | undefined;
    const next = await this.file.update((current) => {
      const result = createGlobalHistoryIntent(current, recordId, operation, now);
      created = result.intent;
      return result.envelope;
    });
    return {
      ...(created ? { intent: created } : {}),
      ...(created
        ? { record: next.records.find((record) => record.id === recordId) }
        : {})
    };
  }

  public async claimIntent(
    workspaceKey: string,
    now = Date.now()
  ): Promise<{ readonly intent?: GlobalHistoryIntent; readonly record?: GlobalHistoryRecord }> {
    let claimed: ReturnType<typeof claimGlobalHistoryIntent> | undefined;
    await this.file.update((current) => {
      claimed = claimGlobalHistoryIntent(current, workspaceKey, now);
      return claimed.envelope;
    });
    return {
      ...(claimed?.intent ? { intent: claimed.intent } : {}),
      ...(claimed?.record ? { record: claimed.record } : {})
    };
  }
}

export class GlobalHistoryService implements vscode.Disposable {
  private readonly changedEmitter: vscode.EventEmitter<void>;
  private readonly intentEmitter: vscode.EventEmitter<{
    readonly intent: GlobalHistoryIntent;
    readonly record: GlobalHistoryRecord;
  }>;
  private readonly subscription: vscode.Disposable;
  private envelope: GlobalHistoryEnvelope = emptyGlobalHistory();
  private pollTimer: NodeJS.Timeout | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private syncChain: Promise<void> = Promise.resolve();
  private initialized = false;
  private unavailable = false;
  private claimingIntent = false;
  public readonly onDidChange: vscode.Event<void>;
  public readonly onDidReceiveIntent: vscode.Event<{
    readonly intent: GlobalHistoryIntent;
    readonly record: GlobalHistoryRecord;
  }>;

  public constructor(
    vscodeApi: typeof import('vscode'),
    private readonly store: GlobalHistoryStore,
    private readonly sessions: SessionManager,
    public readonly workspace: WorkspaceIdentity | undefined,
    private readonly enabled: boolean
  ) {
    this.changedEmitter = new vscodeApi.EventEmitter<void>();
    this.intentEmitter = new vscodeApi.EventEmitter();
    this.onDidChange = this.changedEmitter.event;
    this.onDidReceiveIntent = this.intentEmitter.event;
    this.subscription = sessions.onDidChange(() => this.scheduleSync());
  }

  public async initialize(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      await this.store.initialize();
      this.envelope = await this.store.load();
      this.initialized = true;
      await this.syncNow();
      await this.checkForIntent();
      this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    } catch {
      this.unavailable = true;
    }
  }

  public health(): 'current' | 'disabled' | 'unavailable' {
    return !this.enabled
      ? 'disabled'
      : this.unavailable
        ? 'unavailable'
        : 'current';
  }

  public list(): readonly GlobalHistoryRecord[] {
    return this.envelope.records;
  }

  public get(id: string): GlobalHistoryRecord | undefined {
    return this.envelope.records.find((record) => record.id === id);
  }

  public isCurrentWorkspace(record: GlobalHistoryRecord): boolean {
    return this.workspace?.key === record.workspace.key;
  }

  public async createIntent(
    recordId: string,
    operation: GlobalHistoryIntent['operation']
  ): Promise<{ readonly intent?: GlobalHistoryIntent; readonly record?: GlobalHistoryRecord }> {
    const result = await this.store.createIntent(recordId, operation);
    await this.poll(true);
    return result;
  }

  public async claimIntent(): Promise<{
    readonly intent?: GlobalHistoryIntent;
    readonly record?: GlobalHistoryRecord;
  }> {
    if (!this.enabled || !this.workspace) {
      return {};
    }
    const result = await this.store.claimIntent(this.workspace.key);
    await this.poll(true);
    return result;
  }

  public async deleteRecord(id: string): Promise<boolean> {
    const existed = this.envelope.records.some((record) => record.id === id);
    if (!existed) {
      return false;
    }
    this.envelope = await this.store.deleteRecords([id]);
    this.changedEmitter.fire();
    return true;
  }

  public async deleteClosedHistory(): Promise<number> {
    const ids = this.envelope.records
      .filter(
        (record) => record.archivedAt !== undefined || record.status === 'closed'
      )
      .map((record) => record.id);
    if (ids.length > 0) {
      this.envelope = await this.store.deleteRecords(ids);
      this.changedEmitter.fire();
    }
    return ids.length;
  }

  public dispose(): void {
    this.subscription.dispose();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.changedEmitter.dispose();
    this.intentEmitter.dispose();
  }

  private scheduleSync(): void {
    if (!this.enabled || !this.initialized || !this.workspace) {
      return;
    }
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncNow();
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncNow(): Promise<void> {
    if (!this.enabled || !this.workspace) {
      return;
    }
    this.syncChain = this.syncChain
      .catch(() => undefined)
      .then(async () => {
        const records = this.sessions.history().map((session) => {
          const events = this.sessions.eventsFor(session.id);
          return globalHistoryRecord(session, this.workspace!, {
            events: events.length,
            attention: events.filter((event) => event.attention !== 'none').length
          });
        });
        this.envelope = await this.store.replaceWorkspace(
          this.workspace!.key,
          records
        );
        this.changedEmitter.fire();
      });
    return this.syncChain;
  }

  private async poll(force = false): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      const next = await this.store.load();
      if (force || next.revision !== this.envelope.revision) {
        this.envelope = next;
        this.changedEmitter.fire();
        await this.checkForIntent();
      }
    } catch {
      // A transient read failure must not replace the last known good history.
    }
  }

  private async checkForIntent(): Promise<void> {
    if (
      this.claimingIntent ||
      !this.workspace ||
      !this.envelope.intents.some(
        (intent) => intent.workspaceKey === this.workspace!.key
      )
    ) {
      return;
    }
    this.claimingIntent = true;
    try {
      const claimed = await this.store.claimIntent(this.workspace.key);
      this.envelope = await this.store.load();
      if (claimed.intent && claimed.record) {
        this.intentEmitter.fire({
          intent: claimed.intent,
          record: claimed.record
        });
      }
    } finally {
      this.claimingIntent = false;
    }
  }
}

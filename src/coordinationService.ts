import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CoordinationEndpointBroker } from './coordinationEndpoint';
import {
  COORDINATION_HEARTBEAT_MS,
  COORDINATION_PROTOCOL_VERSION,
  type CoordinatedWindow,
  type CoordinatedWindowRegistration,
  type CoordinationAction
} from './coordinationModel';
import type { SessionManager } from './sessionManager';
import type { WorkspaceIdentity } from './globalHistoryModel';
import type { CoordinationClient } from './coordinationClient';

const TOKEN_KEY = 'lookout.crossWindowCoordinatorToken.v1';
const TOKEN_LOCK_FILE = 'coordination-v1.secret.lock';

export type CoordinationHealth =
  | 'disabled'
  | 'starting'
  | 'healthy-owner'
  | 'healthy-client'
  | 'degraded'
  | 'incompatible';

export class CoordinationService implements vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly windowId = randomUUID();
  private broker: CoordinationEndpointBroker | undefined;
  private client: CoordinationClient | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private heartbeatInFlight: Promise<void> | undefined;
  private remoteWindows: readonly CoordinatedWindow[] = [];
  private healthValue: CoordinationHealth = 'disabled';
  private detailValue = 'Cross-window coordination is disabled.';
  private owned = false;
  private disposed = false;
  public readonly onDidChange = this.changedEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessions: SessionManager,
    public readonly workspace: WorkspaceIdentity | undefined
  ) {
    this.disposables.push(
      sessions.onDidChange(() => this.scheduleHeartbeat()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('lookout.experimental.crossWindowCoordination')) {
          void this.restart();
        }
      })
    );
  }

  public async initialize(): Promise<void> {
    if (!this.enabled()) {
      this.setHealth('disabled', 'Cross-window coordination is disabled.');
      return;
    }
    await this.start();
  }

  public health(): { readonly state: CoordinationHealth; readonly detail: string } {
    return { state: this.healthValue, detail: this.detailValue };
  }

  public windows(): readonly CoordinatedWindow[] {
    return this.remoteWindows;
  }

  public providerCollision(
    provider: 'codex' | 'claude',
    providerSessionId: string
  ): { readonly window: CoordinatedWindow; readonly sessionId: string } | undefined {
    const fingerprint = providerFingerprint(provider, providerSessionId);
    for (const window of this.remoteWindows) {
      const session = window.sessions.find(
        (candidate) => candidate.providerSessionFingerprint === fingerprint
      );
      if (session) {
        return { window, sessionId: session.sessionId };
      }
    }
    return undefined;
  }

  public async focusRemote(windowId: string, sessionId: string): Promise<boolean> {
    const client = this.client;
    if (!client) {
      return false;
    }
    try {
      const accepted = await client.focus(this.windowId, windowId, sessionId);
      if (!accepted) {
        await this.heartbeat();
      }
      return accepted;
    } catch {
      this.setHealth('degraded', 'The execution-host coordinator is unavailable.');
      return false;
    }
  }

  public dispose(): void {
    this.disposed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    void this.broker?.dispose();
    this.changedEmitter.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace
      .getConfiguration('lookout.experimental')
      .get('crossWindowCoordination', false);
  }

  private async restart(): Promise<void> {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.broker?.dispose();
    this.broker = undefined;
    this.client = undefined;
    this.remoteWindows = [];
    this.owned = false;
    if (!this.enabled()) {
      this.setHealth('disabled', 'Cross-window coordination is disabled.');
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    if (!this.workspace) {
      this.setHealth('degraded', 'Open a folder or saved workspace to coordinate windows.');
      return;
    }
    this.setHealth('starting', 'Connecting to this execution host.');
    try {
      const token = await this.coordinationToken();
      const broker = new CoordinationEndpointBroker(
        this.context.globalStorageUri.fsPath
      );
      const connection = await broker.connectOrOwn(token, this.windowId);
      if (connection.state !== 'connected') {
        await broker.dispose();
        this.setHealth(
          connection.state === 'incompatible' ? 'incompatible' : 'degraded',
          connection.detail
        );
        if (connection.state === 'unavailable') {
          this.scheduleRecovery();
        }
        return;
      }
      this.broker = broker;
      this.client = connection.client;
      this.owned = connection.owned;
      await this.heartbeat();
      this.heartbeatTimer = setInterval(
        () => void this.heartbeat(),
        COORDINATION_HEARTBEAT_MS
      );
    } catch {
      this.setHealth('degraded', 'Could not start the execution-host coordinator.');
      this.scheduleRecovery();
    }
  }

  private scheduleHeartbeat(): void {
    if (!this.client || this.heartbeatInFlight) {
      return;
    }
    queueMicrotask(() => void this.heartbeat());
  }

  private heartbeat(): Promise<void> {
    if (this.heartbeatInFlight) {
      return this.heartbeatInFlight;
    }
    const client = this.client;
    if (!client || !this.workspace || this.disposed) {
      return Promise.resolve();
    }
    this.heartbeatInFlight = client
      .heartbeat(this.registration())
      .then(async (result) => {
        this.remoteWindows = result.windows;
        this.setHealth(
          this.owned ? 'healthy-owner' : 'healthy-client',
          this.owned
            ? 'Coordinating windows on this execution host.'
            : 'Connected to this execution-host coordinator.'
        );
        for (const action of result.actions) {
          await this.applyAction(action);
        }
        this.changedEmitter.fire();
      })
      .catch(() => {
        this.remoteWindows = [];
        this.setHealth('degraded', 'Lost contact with the execution-host coordinator.');
        this.scheduleRecovery();
      })
      .finally(() => {
        this.heartbeatInFlight = undefined;
      });
    return this.heartbeatInFlight;
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer || this.disposed || !this.enabled()) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.restart();
    }, 1_000);
  }

  private registration(): CoordinatedWindowRegistration {
    return {
      protocolVersion: COORDINATION_PROTOCOL_VERSION,
      windowId: this.windowId,
      workspaceKey: this.workspace!.key,
      workspaceLabel: this.workspace!.label,
      hostKind: this.workspace!.hostKind,
      observedAt: Date.now(),
      sessions: this.sessions
        .list()
        .filter((session) => this.sessions.isOpen(session.id))
        .map((session) => {
          const provider = session.providerSessions.at(-1);
          return {
            sessionId: session.id,
            label: session.label,
            kind: session.kind,
            status: session.status,
            unread: session.unread,
            updatedAt: session.updatedAt,
            ...(provider
              ? {
                  providerSessionFingerprint: providerFingerprint(
                    provider.provider,
                    provider.id
                  )
                }
              : {})
          };
        })
    };
  }

  private async applyAction(action: CoordinationAction): Promise<void> {
    if (
      action.kind !== 'focus-session' ||
      action.targetWindowId !== this.windowId ||
      !this.sessions.isOpen(action.sessionId)
    ) {
      return;
    }
    await this.sessions.focus(action.sessionId);
    void vscode.window.showInformationMessage(
      'Lookout focused an agent requested from another VS Code window.'
    );
  }

  private async coordinationToken(): Promise<string> {
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    const lockPath = path.join(
      this.context.globalStorageUri.fsPath,
      TOKEN_LOCK_FILE
    );
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const existing = await this.context.secrets.get(TOKEN_KEY);
      if (existing) {
        return existing;
      }
      try {
        const lock = await open(lockPath, 'wx', 0o600);
        try {
          const afterLock = await this.context.secrets.get(TOKEN_KEY);
          if (afterLock) {
            return afterLock;
          }
          const generated = randomBytes(32).toString('base64url');
          await this.context.secrets.store(TOKEN_KEY, generated);
          return generated;
        } finally {
          await lock.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
        }
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        try {
          const details = await stat(lockPath);
          if (Date.now() - details.mtimeMs > 10_000) {
            await unlink(lockPath).catch(() => undefined);
          }
        } catch (statError) {
          if (errorCode(statError) !== 'ENOENT') {
            throw statError;
          }
        }
        await delay(25);
      }
    }
    throw new Error('Timed out creating the shared coordinator secret');
  }

  private setHealth(state: CoordinationHealth, detail: string): void {
    const changed = state !== this.healthValue || detail !== this.detailValue;
    this.healthValue = state;
    this.detailValue = detail;
    if (changed) {
      this.changedEmitter.fire();
    }
  }
}

export function providerFingerprint(
  provider: 'codex' | 'claude',
  providerSessionId: string
): string {
  return createHash('sha256')
    .update(provider)
    .update('\0')
    .update(providerSessionId)
    .digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

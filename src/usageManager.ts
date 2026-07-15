import * as vscode from 'vscode';
import { CodexUsageProvider } from './codexUsageProvider';
import { hostSpawnPathOverride } from './executableResolver';
import type { SessionManager } from './sessionManager';
import type { UsageSnapshot } from './usageTypes';

const CLAUDE_STORAGE_KEY = 'lookout.usage.claude.v1';
const STALE_AFTER_MS = 15 * 60 * 1000;

export class UsageManager implements vscode.Disposable {
  private readonly snapshots = new Map<UsageSnapshot['provider'], UsageSnapshot>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly codex: CodexUsageProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  public readonly onDidChange = this.changedEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    sessions: SessionManager
  ) {
    const executable = vscode.workspace
      .getConfiguration('lookout.usage.codex')
      .get('executable', 'codex');
    const includeSparkLimits = vscode.workspace
      .getConfiguration('lookout.usage.codex')
      .get('showSparkLimits', false);
    this.codex = new CodexUsageProvider(
      executable,
      (snapshot) => this.setSnapshot(snapshot),
      includeSparkLimits,
      hostSpawnPathOverride
    );
    const cachedClaude = context.globalState.get<UsageSnapshot>(CLAUDE_STORAGE_KEY);
    this.snapshots.set(
      'claude',
      cachedClaude
        ? withStaleness(cachedClaude)
        : {
            provider: 'claude',
            status: 'waiting',
            observedAt: Date.now(),
            source: 'claude-statusline',
            windows: [],
            detail: 'Launch Claude and send a message to receive usage limits'
          }
    );
    this.disposables.push(
      sessions.onDidReceiveUsage((event) => {
        if (event.kind === 'delegated-agents') {
          return;
        }
        const snapshot: UsageSnapshot = {
          provider: 'claude',
          status: event.windows.length > 0 ? 'available' : 'waiting',
          observedAt: event.observedAt,
          source: 'claude-statusline',
          windows: event.windows,
          ...(event.windows.length === 0
            ? { detail: 'Claude did not report subscription quota windows' }
            : {})
        };
        if (this.setSnapshot(snapshot)) {
          void this.context.globalState.update(CLAUDE_STORAGE_KEY, snapshot);
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('lookout.usage.codex.enabled') ||
          event.affectsConfiguration('lookout.usage.claude.enabled')
        ) {
          this.changedEmitter.fire();
        }
        if (event.affectsConfiguration('lookout.usage.codex.showSparkLimits')) {
          this.codex.setIncludeSparkLimits(
            vscode.workspace
              .getConfiguration('lookout.usage.codex')
              .get('showSparkLimits', false)
          );
          void this.refresh();
        }
      })
    );
  }

  public initialize(): void {
    this.refreshTimer = setInterval(() => void this.refresh(), 90_000);
    if (providerEnabled('codex')) {
      void this.codex.start();
    }
  }

  public list(): readonly UsageSnapshot[] {
    return (['codex', 'claude'] as const)
      .filter(providerEnabled)
      .map(
      (provider) =>
        withStaleness(this.snapshots.get(provider) ?? fallbackSnapshot(provider))
      );
  }

  public async refresh(): Promise<void> {
    if (providerEnabled('codex')) {
      await this.codex.refresh();
    }
    const claude = this.snapshots.get('claude');
    if (claude) {
      this.snapshots.set('claude', withStaleness(claude));
      this.changedEmitter.fire();
    }
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.codex.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
  }

  private setSnapshot(snapshot: UsageSnapshot): boolean {
    const current = this.snapshots.get(snapshot.provider);
    if (current && snapshot.observedAt < current.observedAt) {
      return false;
    }
    this.snapshots.set(snapshot.provider, snapshot);
    this.changedEmitter.fire();
    return true;
  }
}

function providerEnabled(provider: UsageSnapshot['provider']): boolean {
  return vscode.workspace
    .getConfiguration(`lookout.usage.${provider}`)
    .get('enabled', true);
}

function withStaleness(snapshot: UsageSnapshot): UsageSnapshot {
  if (
    snapshot.status === 'available' &&
    Date.now() - snapshot.observedAt > STALE_AFTER_MS
  ) {
    return { ...snapshot, status: 'stale', detail: 'Last update is stale' };
  }
  return snapshot;
}

function fallbackSnapshot(provider: UsageSnapshot['provider']): UsageSnapshot {
  return {
    provider,
    status: 'waiting',
    observedAt: Date.now(),
    source: provider === 'codex' ? 'codex-app-server' : 'claude-statusline',
    windows: []
  };
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionEvent } from './sessionEvents';
import type { SessionManager } from './sessionManager';
import {
  operationalStatsTooltipLines,
  sessionOperationalStats
} from './sessionStats';
import type { AgentSession, SessionStatus } from './types';
import {
  sessionTokenDetailLines,
  sessionTokenSummary,
  tokenUsageSeverity
} from './sessionTokenUsage';

const STATUS_ICONS: Record<SessionStatus, vscode.ThemeIcon> = {
  starting: new vscode.ThemeIcon('loading~spin'),
  active: new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green')),
  running: new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green')),
  background: new vscode.ThemeIcon('run-all', new vscode.ThemeColor('charts.blue')),
  attention: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground')),
  idle: new vscode.ThemeIcon('bell', new vscode.ThemeColor('charts.green')),
  completed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
  unknown: new vscode.ThemeIcon('question'),
  closed: new vscode.ThemeIcon('circle-slash')
};

export class SessionTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly session: AgentSession,
    events: readonly SessionEvent[] = []
  ) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    const stats = sessionOperationalStats(session, events);
    this.id = session.id;
    this.contextValue = 'lookout.session';
    this.description = sessionDescription(session);
    this.tooltip = [
      session.label,
      `Agent: ${session.kind}`,
      `Status: ${session.status}`,
      `Directory: ${session.cwd}`,
      ...(session.baseline ? [`Branch: ${session.baseline.branch}`] : []),
      `Attention bridge: ${session.bridgeAvailable ? 'connected' : 'unavailable'}`,
      `Lifecycle integration: ${integrationLabel(session.integration.lifecycle)}`,
      ...(session.providerSessions.at(-1)
        ? [
            'Provider session: observed',
            `Provider identity last seen: ${new Date(
              session.providerSessions.at(-1)?.lastSeenAt ?? 0
            ).toLocaleString()}`
          ]
        : session.kind === 'custom'
          ? ['Provider session: not applicable']
          : ['Provider session: awaiting first hook event']),
      ...(session.integration.conflict
        ? ['Integration warning: provider session identity conflict']
        : []),
      ...sessionTokenDetailLines(session),
      ...operationalStatsTooltipLines(stats)
    ].join('\n');
    this.iconPath = sessionIcon(session);
    this.command = {
      command: 'lookout.focusSession',
      title: 'Focus Agent',
      arguments: [this]
    };
    this.accessibilityInformation = {
      label: `${session.label}, ${session.status}${session.unread ? ', unread' : ''}`
    };
  }
}

function integrationLabel(
  lifecycle: AgentSession['integration']['lifecycle']
): string {
  switch (lifecycle) {
    case 'disabled':
      return 'disabled or terminal-only';
    case 'bridge-unavailable':
      return 'bridge unavailable';
    case 'injection-skipped':
      return 'hooks unavailable for this launch command or shell';
    case 'awaiting-first-hook':
      return 'awaiting first trusted hook event';
    case 'healthy':
      return 'healthy';
    case 'stale':
      return 'degraded';
  }
}

export class SessionTreeProvider
  implements vscode.TreeDataProvider<SessionTreeItem>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly managerSubscription: vscode.Disposable;
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: SessionManager) {
    this.managerSubscription = manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): SessionTreeItem[] {
    return this.manager
      .list()
      .map(
        (session) =>
          new SessionTreeItem(session, this.manager.eventsFor(session.id))
      );
  }

  public refresh(): void {
    this.changedEmitter.fire();
  }

  public dispose(): void {
    this.managerSubscription.dispose();
    this.changedEmitter.dispose();
  }
}

export class SessionStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90
  );
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly manager: SessionManager) {
    this.subscription = manager.onDidChange(() => this.refresh());
    this.refresh();
    this.item.show();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private refresh(): void {
    const sessions = this.manager.list();
    const unread = sessions.filter((session) => session.unread).length;
    const attention = sessions.filter(
      (session) => session.status === 'attention'
    ).length;
    if (attention > 0) {
      this.item.text = `$(bell-dot) ${attention} agent${attention === 1 ? '' : 's'}`;
      this.item.tooltip = `${attention} waiting for you · ${unread} unread`;
      this.item.command = 'lookout.focusNextAttention';
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      return;
    }
    if (unread > 0) {
      this.item.text = `$(bell) ${unread} agent${unread === 1 ? '' : 's'}`;
      this.item.tooltip = `${unread} finished · none waiting for input`;
      this.item.command = 'lookout.pickSession';
      this.item.backgroundColor = undefined;
      return;
    }
    this.item.text = `$(terminal) ${this.manager.activeCount}`;
    this.item.tooltip = `${this.manager.activeCount} active agent${
      this.manager.activeCount === 1 ? '' : 's'
    }`;
    this.item.command = 'lookout.pickSession';
    this.item.backgroundColor = undefined;
  }
}

function sessionDescription(session: AgentSession): string {
  const directory = path.basename(session.cwd);
  const unread = session.unread ? '● ' : '';
  const detail = statusLabel(session.status);
  const branch = session.baseline?.branch ? ` · ${session.baseline.branch}` : '';
  const tokens = sessionTokenSummary(session);
  return `${unread}${directory}${branch} · ${detail}${
    tokens ? ` · ${tokens}` : ''
  }`;
}

function sessionIcon(session: AgentSession): vscode.ThemeIcon {
  const base = STATUS_ICONS[session.status];
  if (session.status === 'attention' || session.status === 'failed') {
    return base;
  }
  const severity = tokenUsageSeverity(
    session,
    vscode.workspace
      .getConfiguration('lookout.usage')
      .get('warningThreshold', 80),
    vscode.workspace
      .getConfiguration('lookout.usage')
      .get('criticalThreshold', 95)
  );
  if (severity === 'critical') {
    return new vscode.ThemeIcon(base.id, new vscode.ThemeColor('list.errorForeground'));
  }
  if (severity === 'warning') {
    return new vscode.ThemeIcon(
      base.id,
      new vscode.ThemeColor('list.warningForeground')
    );
  }
  return base;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'starting':
      return 'starting';
    case 'active':
      return 'active';
    case 'running':
      return 'working';
    case 'background':
      return 'delegated work active';
    case 'attention':
      return 'needs attention';
    case 'idle':
      return 'turn finished';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'unknown':
      return 'unknown';
    case 'closed':
      return 'closed';
  }
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  CoordinatedSession,
  CoordinatedWindow
} from './coordinationModel';
import type { CoordinationService } from './coordinationService';
import { dedupeCoordinatedSessions } from './historyQuery';
import type { SessionEvent } from './sessionEvents';
import type { SessionManager } from './sessionManager';
import {
  normalizeSessionOrder,
  reorderSessionIds
} from './sessionOrder';
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
const SESSION_ORDER_KEY = 'lookout.sessionOrder.v1';
const SESSION_TREE_MIME = 'application/vnd.code.tree.lookout.sessions';

export type SessionTreeElement =
  | SessionGroupItem
  | SessionTreeItem
  | LiveSessionTreeItem;

export class SessionGroupItem extends vscode.TreeItem {
  public constructor(
    public readonly group: 'current' | 'live',
    label: string,
    count: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `session-group-${group}`;
    this.contextValue = `lookout.sessionGroup.${group}`;
    this.description = String(count);
    this.iconPath = group === 'current'
      ? new vscode.ThemeIcon('window')
      : new vscode.ThemeIcon('broadcast');
  }
}

const READ_WAITING_ICONS: Partial<Record<SessionStatus, vscode.ThemeIcon>> = {
  attention: new vscode.ThemeIcon('question'),
  idle: new vscode.ThemeIcon('debug-pause')
};
const MCP_ACTIVITY_ICON = new vscode.ThemeIcon(
  'extensions',
  new vscode.ThemeColor('charts.blue')
);

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

export class LiveSessionTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly coordinatedWindow: CoordinatedWindow,
    public readonly coordinatedSession: CoordinatedSession
  ) {
    super(coordinatedSession.label, vscode.TreeItemCollapsibleState.None);
    this.id = `live-${coordinatedWindow.windowId}-${coordinatedSession.sessionId}`;
    this.contextValue = 'lookout.liveSession';
    this.description = `${coordinatedWindow.workspaceLabel} · ${coordinatedSession.status}${coordinatedSession.unread ? ' · unread' : ''}`;
    this.iconPath = coordinatedSession.status === 'attention' &&
      coordinatedSession.unread
      ? new vscode.ThemeIcon(
          'bell-dot',
          new vscode.ThemeColor('list.warningForeground')
        )
      : new vscode.ThemeIcon('broadcast');
    this.tooltip = [
      coordinatedSession.label,
      `Owning project: ${coordinatedWindow.workspaceLabel}`,
      `Provider: ${coordinatedSession.kind}`,
      `Live status: ${coordinatedSession.status}`,
      `Execution host: ${hostLabel(coordinatedWindow.hostKind)}`,
      `Lease expires: ${new Date(coordinatedWindow.leaseExpiresAt).toLocaleTimeString()}`,
      'Lookout will ask the owning window to reveal this terminal.'
    ].join('\n');
    this.command = {
      command: 'lookout.focusRemoteSession',
      title: 'Focus Agent in Owning Window',
      arguments: [this]
    };
    this.accessibilityInformation = {
      label: `${coordinatedSession.label}, ${coordinatedWindow.workspaceLabel}, live ${coordinatedSession.status}`
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
  implements
    vscode.TreeDataProvider<SessionTreeElement>,
    vscode.TreeDragAndDropController<SessionTreeElement>,
    vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private sessionOrder: string[];
  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly dragMimeTypes = [SESSION_TREE_MIME];
  public readonly dropMimeTypes = [SESSION_TREE_MIME];

  public constructor(
    private readonly manager: SessionManager,
    private readonly coordination: CoordinationService,
    private readonly state: vscode.Memento
  ) {
    this.sessionOrder = normalizeSessionOrder(
      state.get<unknown>(SESSION_ORDER_KEY),
      manager.list().map((session) => session.id)
    );
    this.subscriptions = [
      manager.onDidChange(() => this.changedEmitter.fire()),
      coordination.onDidChange(() => this.changedEmitter.fire())
    ];
  }

  public getTreeItem(element: SessionTreeElement): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SessionTreeElement): SessionTreeElement[] {
    const sessions = this.manager.list();
    this.sessionOrder = normalizeSessionOrder(
      this.sessionOrder,
      sessions.map((session) => session.id)
    );
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const local = this.sessionOrder.flatMap((id) => {
      const session = sessionsById.get(id);
      return session
        ? [new SessionTreeItem(session, this.manager.eventsFor(session.id))]
        : [];
    });
    const live = dedupeCoordinatedSessions(this.coordination.windows())
      .map(({ window, session }) => new LiveSessionTreeItem(window, session))
      .sort((left, right) => {
        const leftPriority = liveSessionPriority(left.coordinatedSession);
        const rightPriority = liveSessionPriority(right.coordinatedSession);
        return rightPriority - leftPriority ||
          right.coordinatedSession.updatedAt - left.coordinatedSession.updatedAt;
      });
    if (!element) {
      if (
        local.length === 0 &&
        this.coordination.health().state === 'disabled'
      ) {
        return [];
      }
      return [
        new SessionGroupItem('current', 'Current Workspace', local.length),
        ...(this.coordination.health().state !== 'disabled'
          ? [new SessionGroupItem('live', 'Live in Other Windows', live.length)]
          : [])
      ];
    }
    if (!(element instanceof SessionGroupItem)) {
      return [];
    }
    if (element.group === 'current') {
      return local;
    }
    return live.length > 0
      ? live
      : [new vscode.TreeItem(
          this.coordination.health().state === 'degraded'
            ? 'Coordinator unavailable'
            : 'No other Lookout windows are live',
          vscode.TreeItemCollapsibleState.None
        ) as SessionTreeElement];
  }

  public handleDrag(
    source: readonly SessionTreeElement[],
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): void {
    if (token.isCancellationRequested) {
      return;
    }
    const ids = source.flatMap((item) =>
      item instanceof SessionTreeItem ? [item.session.id] : []
    );
    if (ids.length > 0) {
      dataTransfer.set(SESSION_TREE_MIME, new vscode.DataTransferItem(ids));
    }
  }

  public async handleDrop(
    target: SessionTreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (
      token.isCancellationRequested ||
      target instanceof LiveSessionTreeItem ||
      (target instanceof SessionGroupItem && target.group !== 'current')
    ) {
      return;
    }
    const value = dataTransfer.get(SESSION_TREE_MIME)?.value;
    const draggedIds = Array.isArray(value)
      ? value.filter((candidate): candidate is string => typeof candidate === 'string')
      : [];
    const activeIds = this.manager.list().map((session) => session.id);
    const next = reorderSessionIds(
      this.sessionOrder,
      activeIds,
      draggedIds,
      target instanceof SessionTreeItem ? target.session.id : undefined
    );
    if (
      next.length === this.sessionOrder.length &&
      next.every((id, index) => id === this.sessionOrder[index])
    ) {
      return;
    }
    this.sessionOrder = next;
    this.changedEmitter.fire();
    await this.state.update(SESSION_ORDER_KEY, next);
  }

  public refresh(): void {
    this.changedEmitter.fire();
  }

  public dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
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
      (session) => session.status === 'attention' && session.unread
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
  if (
    session.status === 'running' &&
    session.runningCommands.some((activity) => activity.activityKind === 'mcp')
  ) {
    return MCP_ACTIVITY_ICON;
  }
  const base = session.unread
    ? STATUS_ICONS[session.status]
    : (READ_WAITING_ICONS[session.status] ?? STATUS_ICONS[session.status]);
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

function liveSessionPriority(session: CoordinatedSession): number {
  if (session.status === 'attention' && session.unread) {
    return 2;
  }
  return session.unread ? 1 : 0;
}

function hostLabel(kind: CoordinatedWindow['hostKind']): string {
  switch (kind) {
    case 'local': return 'local';
    case 'wsl': return 'WSL';
    case 'ssh': return 'Remote SSH';
    case 'dev-container': return 'dev container';
    case 'other': return 'remote extension host';
  }
}

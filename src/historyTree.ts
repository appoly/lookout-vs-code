import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildHistoryEntries,
  dedupeCoordinatedSessions,
  historyAvailabilityLabel,
  liveSessionKey,
  safeHistoryLatestEvent,
  type HistoryAvailability,
  type HistoryEntry
} from './historyQuery';
import type { SessionManager } from './sessionManager';
import type { SessionEvent } from './sessionEvents';
import {
  operationalStatsTooltipLines,
  sessionOperationalStats
} from './sessionStats';
import type { AgentSession } from './types';
import type {
  GlobalHistoryRecord
} from './globalHistoryModel';
import type { GlobalHistoryService } from './globalHistoryStore';
import type {
  CoordinatedSession,
  CoordinatedWindow
} from './coordinationModel';
import type { CoordinationService } from './coordinationService';

const HISTORY_ICONS: Readonly<Record<HistoryAvailability, vscode.ThemeIcon>> = {
  open: new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green')),
  resumable: new vscode.ThemeIcon('debug-restart'),
  'terminal-only': new vscode.ThemeIcon('history'),
  closed: new vscode.ThemeIcon('circle-slash'),
  archived: new vscode.ThemeIcon('archive')
};

export type HistoryTreeElement =
  | HistoryGroupItem
  | HistoryTreeItem
  | GlobalHistoryTreeItem
  | LiveHistoryTreeItem;

export class HistoryGroupItem extends vscode.TreeItem {
  public constructor(
    public readonly group: 'current' | 'projects' | 'live',
    label: string,
    count: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `history-group-${group}`;
    this.contextValue = `lookout.historyGroup.${group}`;
    this.description = String(count);
    this.iconPath = group === 'current'
      ? new vscode.ThemeIcon('window')
      : group === 'projects'
        ? new vscode.ThemeIcon('folder-library')
        : new vscode.ThemeIcon('broadcast');
  }
}

export class HistoryTreeItem extends vscode.TreeItem {
  public readonly session: AgentSession;

  public constructor(
    public readonly entry: HistoryEntry,
    events: readonly SessionEvent[] = []
  ) {
    const { session, availability } = entry;
    super(session.label, vscode.TreeItemCollapsibleState.None);
    const stats = sessionOperationalStats(session, events);
    this.session = session;
    this.id = `history-${session.id}`;
    this.contextValue = `lookout.historySession.${availability}`;
    this.description = `${historyAvailabilityLabel(availability)} · ${path.basename(session.cwd)}`;
    this.iconPath = HISTORY_ICONS[availability];
    const identity = session.providerSessions.at(-1);
    this.tooltip = [
      session.label,
      `Provider: ${session.kind}`,
      `Availability: ${historyAvailabilityLabel(availability)}`,
      `Directory: ${session.cwd}`,
      `Provider identity: ${identity ? 'observed' : 'not available'}`,
      `Latest: ${safeHistoryLatestEvent(entry.latestEvent)}`,
      `Last activity: ${new Date(entry.lastActivityAt).toLocaleString()}`,
      ...operationalStatsTooltipLines(stats)
    ].join('\n');
    this.command = availability === 'open'
      ? {
          command: 'lookout.focusSession',
          title: 'Focus Agent',
          arguments: [this]
        }
      : availability === 'resumable'
        ? {
            command: 'lookout.resumeSession',
            title: 'Resume Agent',
            arguments: [this]
          }
        : undefined;
    this.accessibilityInformation = {
      label: `${session.label}, ${historyAvailabilityLabel(availability)}, ${session.kind}`
    };
  }
}

export class GlobalHistoryTreeItem extends vscode.TreeItem {
  public constructor(public readonly record: GlobalHistoryRecord) {
    super(record.label, vscode.TreeItemCollapsibleState.None);
    const resumable = record.provider?.state === 'available' &&
      record.archivedAt === undefined;
    const availability = record.archivedAt !== undefined
      ? 'archived'
      : resumable
        ? 'resumable'
        : 'terminal-only';
    this.id = `global-history-${record.id}`;
    this.contextValue = `lookout.globalHistory.${availability}`;
    this.description = `${record.workspace.label} · ${resumable ? 'resumable' : 'history only'}`;
    this.iconPath = resumable
      ? new vscode.ThemeIcon('debug-restart')
      : new vscode.ThemeIcon('folder');
    this.tooltip = [
      record.label,
      `Project: ${record.workspace.label}`,
      `Execution host: ${hostLabel(record.workspace.hostKind)}`,
      `Provider: ${record.kind}`,
      `Directory: ${record.cwd}`,
      `State when last observed: ${record.status}`,
      `Recorded events: ${record.eventCount}`,
      `Attention events: ${record.attentionEventCount}`,
      `Last activity: ${new Date(record.updatedAt).toLocaleString()}`,
      'This is historical metadata; it does not claim the old terminal is live.'
    ].join('\n');
    this.command = resumable
      ? {
          command: 'lookout.resumeGlobalSession',
          title: 'Open Project and Resume',
          arguments: [this]
        }
      : {
          command: 'lookout.openGlobalHistory',
          title: 'Open Project',
          arguments: [this]
        };
    this.accessibilityInformation = {
      label: `${record.label}, ${record.workspace.label}, ${resumable ? 'resumable' : 'history only'}`
    };
  }
}

export class LiveHistoryTreeItem extends vscode.TreeItem {
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
      ? new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'))
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

export class HistoryTreeProvider
  implements vscode.TreeDataProvider<HistoryTreeElement>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly manager: SessionManager,
    private readonly globalHistory: GlobalHistoryService,
    private readonly coordination: CoordinationService,
    private readonly maximum = 100
  ) {
    this.subscriptions = [
      manager.onDidChange(() => this.changedEmitter.fire()),
      globalHistory.onDidChange(() => this.changedEmitter.fire()),
      coordination.onDidChange(() => this.changedEmitter.fire())
    ];
  }

  public getTreeItem(element: HistoryTreeElement): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: HistoryTreeElement): HistoryTreeElement[] {
    // A session live in another window would otherwise surface twice: once as
    // a coordinated live row and once as its history record (global for other
    // projects, workspaceState-shared for this workspace opened twice).
    const liveSessions = dedupeCoordinatedSessions(this.coordination.windows());
    const liveKeys = new Set(
      liveSessions.map((entry) =>
        liveSessionKey(entry.window.workspaceKey, entry.session.sessionId)
      )
    );
    const local = this.localItems(liveKeys);
    const projects = this.globalHistory
      .list()
      .filter(
        (record) =>
          !this.globalHistory.isCurrentWorkspace(record) &&
          !liveKeys.has(
            liveSessionKey(record.workspace.key, record.sourceSessionId)
          )
      )
      .slice(0, this.maximum)
      .map((record) => new GlobalHistoryTreeItem(record));
    const live = liveSessions
      .map(
        ({ window, session }) => new LiveHistoryTreeItem(window, session)
      )
      .sort((left, right) => {
        const leftPriority = liveSessionPriority(left.coordinatedSession);
        const rightPriority = liveSessionPriority(right.coordinatedSession);
        return rightPriority - leftPriority ||
          right.coordinatedSession.updatedAt - left.coordinatedSession.updatedAt;
      });
    if (!element) {
      return [
        new HistoryGroupItem('current', 'Current Workspace', local.length),
        ...(projects.length > 0
          ? [new HistoryGroupItem('projects', 'Other Projects', projects.length)]
          : []),
        ...(this.coordination.health().state !== 'disabled'
          ? [new HistoryGroupItem('live', 'Live in Other Windows', live.length)]
          : [])
      ];
    }
    if (!(element instanceof HistoryGroupItem)) {
      return [];
    }
    switch (element.group) {
      case 'current': return local;
      case 'projects': return projects;
      case 'live':
        return live.length > 0
          ? live
          : [new vscode.TreeItem(
              this.coordination.health().state === 'degraded'
                ? 'Coordinator unavailable'
                : 'No other Lookout windows are live',
              vscode.TreeItemCollapsibleState.None
            ) as HistoryTreeElement];
    }
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

  private localItems(liveKeys: ReadonlySet<string>): HistoryTreeItem[] {
    const workspaceKey = this.coordination.workspace?.key;
    return buildHistoryEntries(
      this.manager.history(),
      this.manager.eventsFor(),
      (id) => this.manager.isOpen(id),
      this.maximum
    )
      .filter(
        (entry) =>
          entry.availability === 'open' ||
          !workspaceKey ||
          !liveKeys.has(liveSessionKey(workspaceKey, entry.session.id))
      )
      .map(
        (entry) =>
          new HistoryTreeItem(
            entry,
            this.manager.eventsFor(entry.session.id)
          )
      );
  }
}

function liveSessionPriority(session: CoordinatedSession): number {
  if (session.status === 'attention' && session.unread) {
    return 2;
  }
  return session.unread ? 1 : 0;
}

function hostLabel(kind: GlobalHistoryRecord['workspace']['hostKind']): string {
  switch (kind) {
    case 'local': return 'local';
    case 'wsl': return 'WSL';
    case 'ssh': return 'Remote SSH';
    case 'dev-container': return 'dev container';
    case 'other': return 'remote extension host';
  }
}

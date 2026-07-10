import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionManager } from './sessionManager';
import type { AgentSession, SessionStatus } from './types';

const STATUS_ICONS: Record<SessionStatus, vscode.ThemeIcon> = {
  starting: new vscode.ThemeIcon('loading~spin'),
  active: new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green')),
  running: new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green')),
  background: new vscode.ThemeIcon('run-all', new vscode.ThemeColor('charts.blue')),
  attention: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground')),
  completed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground')),
  unknown: new vscode.ThemeIcon('question'),
  closed: new vscode.ThemeIcon('circle-slash')
};

export class SessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly session: AgentSession) {
    super(session.label, vscode.TreeItemCollapsibleState.None);
    this.id = session.id;
    this.contextValue = 'lookout.session';
    this.description = sessionDescription(session);
    this.tooltip = [
      session.label,
      `Agent: ${session.kind}`,
      `Status: ${session.status}`,
      `Directory: ${session.cwd}`,
      ...(session.baseline ? [`Branch: ${session.baseline.branch}`] : []),
      `Delegated agents: ${session.backgroundAgents.length}`,
      ...session.backgroundAgents.map((agent) => `  • ${agent.label}`),
      `Attention bridge: ${session.bridgeAvailable ? 'connected' : 'unavailable'}`,
      ...(session.latestEvent ? [`Latest: ${session.latestEvent}`] : [])
    ].join('\n');
    this.iconPath = STATUS_ICONS[session.status];
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
    return this.manager.list().map((session) => new SessionTreeItem(session));
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
    if (unread > 0) {
      this.item.text = `$(bell-dot) ${unread} agent${unread === 1 ? '' : 's'}`;
      this.item.tooltip = `${attention} waiting · ${unread} unread`;
      this.item.command = 'lookout.focusNextAttention';
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      return;
    }
    this.item.text = `$(terminal) ${this.manager.activeCount}`;
    this.item.tooltip = `${this.manager.activeCount} active agents`;
    this.item.command = 'lookout.pickSession';
    this.item.backgroundColor = undefined;
  }
}

function sessionDescription(session: AgentSession): string {
  const directory = path.basename(session.cwd);
  const unread = session.unread ? '● ' : '';
  const detail = session.latestEvent ?? session.status;
  const branch = session.baseline?.branch ? ` · ${session.baseline.branch}` : '';
  return `${unread}${directory}${branch} · ${detail}`;
}

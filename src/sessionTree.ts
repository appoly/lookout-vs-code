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
    this.contextValue = 'parful.session';
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
      command: 'parful.focusSession',
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

function sessionDescription(session: AgentSession): string {
  const directory = path.basename(session.cwd);
  const unread = session.unread ? '● ' : '';
  const detail = session.latestEvent ?? session.status;
  const branch = session.baseline?.branch ? ` · ${session.baseline.branch}` : '';
  return `${unread}${directory}${branch} · ${detail}`;
}

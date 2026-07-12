import * as vscode from 'vscode';
import type { UsageManager } from './usageManager';
import type { UsageSnapshot, UsageWindow } from './usageTypes';
import { formatResetDescription, selectStatusWindow } from './usageFormatting';

type UsageTreeValue =
  | { readonly kind: 'provider'; readonly snapshot: UsageSnapshot }
  | { readonly kind: 'window'; readonly snapshot: UsageSnapshot; readonly window: UsageWindow }
  | { readonly kind: 'detail'; readonly label: string; readonly description?: string };

export class UsageTreeItem extends vscode.TreeItem {
  public constructor(public readonly value: UsageTreeValue) {
    super(
      itemLabel(value),
      value.kind === 'provider'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    if (value.kind === 'provider') {
      this.description = providerDescription(value.snapshot);
      this.iconPath = providerIcon(value.snapshot);
      this.tooltip = `${title(value.snapshot.provider)} usage from ${sourceLabel(value.snapshot.source)}\nLast checked ${new Date(value.snapshot.observedAt).toLocaleString()}`;
    } else if (value.kind === 'window') {
      this.description = formatResetDescription(value.window.resetsAt);
      this.iconPath = usageIcon(value.window.usedPercent);
      this.tooltip = `${value.window.usedPercent.toFixed(1)}% used${
        value.window.resetsAt
          ? `\nResets ${new Date(value.window.resetsAt * 1000).toLocaleString()}`
          : ''
      }`;
    } else {
      this.description = value.description;
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}

export class UsageTreeProvider
  implements vscode.TreeDataProvider<UsageTreeItem>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(private readonly manager: UsageManager) {
    this.subscription = manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: UsageTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: UsageTreeItem): UsageTreeItem[] {
    if (!element) {
      return this.manager
        .list()
        .map((snapshot) => new UsageTreeItem({ kind: 'provider', snapshot }));
    }
    if (element.value.kind !== 'provider') {
      return [];
    }
    const snapshot = element.value.snapshot;
    const children = snapshot.windows.map(
      (window) => new UsageTreeItem({ kind: 'window', snapshot, window })
    );
    if (snapshot.detail) {
      children.push(
        new UsageTreeItem({
          kind: 'detail',
          label: snapshot.detail,
          description: statusLabel(snapshot.status)
        })
      );
    }
    if (snapshot.credits?.balance) {
      children.push(
        new UsageTreeItem({
          kind: 'detail',
          label: 'Credits',
          description: snapshot.credits.balance
        })
      );
    }
    return children;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changedEmitter.dispose();
  }
}

export class UsageStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  private readonly subscription: vscode.Disposable;

  public constructor(private readonly manager: UsageManager) {
    this.item.name = 'Lookout Usage Limits';
    this.item.command = 'workbench.view.extension.lookout';
    this.subscription = manager.onDidChange(() => this.render());
    this.render();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private render(): void {
    const values = this.manager.list();
    if (values.length === 0) {
      this.item.hide();
      return;
    }
    const pieces = values.map((snapshot) => {
      const window = selectStatusWindow(snapshot);
      if (!window) {
        return `${title(snapshot.provider)} —`;
      }
      return `${title(snapshot.provider)} ${Math.round(window.usedPercent)}%`;
    });
    const highestUsage = Math.max(
      0,
      ...values.flatMap((snapshot) => {
        const window = selectStatusWindow(snapshot);
        return window ? [window.usedPercent] : [];
      })
    );
    this.item.text = `$(dashboard) ${pieces.join(' · ')}`;
    this.item.tooltip = 'Lookout usage limits — click to open the Lookout view';
    this.item.backgroundColor =
      highestUsage >= criticalThreshold()
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : highestUsage >= warningThreshold()
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.item.show();
  }
}

function itemLabel(value: UsageTreeValue): string {
  if (value.kind === 'provider') {
    return title(value.snapshot.provider);
  }
  if (value.kind === 'window') {
    return `${value.window.label}: ${Math.round(value.window.usedPercent)}% used`;
  }
  return value.label;
}

function title(provider: UsageSnapshot['provider']): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function sourceLabel(source: UsageSnapshot['source']): string {
  return source === 'codex-app-server'
    ? 'the Codex app-server'
    : 'the Claude status line';
}

function statusLabel(status: UsageSnapshot['status']): string {
  return status === 'authRequired' ? 'sign-in required' : status;
}

function providerDescription(snapshot: UsageSnapshot): string {
  const plan = snapshot.plan ? `${snapshot.plan} · ` : '';
  return `${plan}${statusLabel(snapshot.status)}`;
}

function providerIcon(snapshot: UsageSnapshot): vscode.ThemeIcon {
  if (snapshot.status === 'error' || snapshot.status === 'unsupported') {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.errorForeground'));
  }
  if (snapshot.status === 'waiting' || snapshot.status === 'stale') {
    return new vscode.ThemeIcon('clock');
  }
  return new vscode.ThemeIcon(snapshot.provider === 'claude' ? 'sparkle' : 'terminal');
}

function usageIcon(percent: number): vscode.ThemeIcon {
  if (percent >= criticalThreshold()) {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'));
  }
  if (percent >= warningThreshold()) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  }
  return new vscode.ThemeIcon('graph');
}

function warningThreshold(): number {
  return vscode.workspace
    .getConfiguration('lookout.usage')
    .get('warningThreshold', 80);
}

function criticalThreshold(): number {
  return vscode.workspace
    .getConfiguration('lookout.usage')
    .get('criticalThreshold', 95);
}

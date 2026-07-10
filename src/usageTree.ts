import * as vscode from 'vscode';
import type { UsageManager } from './usageManager';
import type { UsageSnapshot, UsageWindow } from './usageTypes';

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
      this.tooltip = `${value.snapshot.provider} usage from ${value.snapshot.source}\nLast checked ${new Date(value.snapshot.observedAt).toLocaleString()}`;
    } else if (value.kind === 'window') {
      this.description = resetDescription(value.window.resetsAt);
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
          description: snapshot.status
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
    this.item.name = 'MultiTerm Usage Limits';
    this.item.command = 'workbench.view.extension.multiTerm';
    this.subscription = manager.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }

  private render(): void {
    const values = this.manager.list();
    const pieces = values.map((snapshot) => {
      const highest = [...snapshot.windows].sort(
        (a, b) => b.usedPercent - a.usedPercent
      )[0];
      if (!highest) {
        return `${title(snapshot.provider)} —`;
      }
      return `${title(snapshot.provider)} ${Math.round(highest.usedPercent)}%`;
    });
    const highestUsage = Math.max(
      0,
      ...values.flatMap((snapshot) => snapshot.windows.map((window) => window.usedPercent))
    );
    this.item.text = `$(dashboard) ${pieces.join(' · ')}`;
    this.item.tooltip = 'MultiTerm usage limits — click to open the cockpit';
    this.item.backgroundColor =
      highestUsage >= criticalThreshold()
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : highestUsage >= warningThreshold()
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
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

function providerDescription(snapshot: UsageSnapshot): string {
  const plan = snapshot.plan ? `${snapshot.plan} · ` : '';
  return `${plan}${snapshot.status}`;
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

function resetDescription(resetsAt: number | undefined): string {
  if (!resetsAt) {
    return '';
  }
  const delta = resetsAt * 1000 - Date.now();
  if (delta <= 0) {
    return 'reset due';
  }
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `resets in ${hours}h ${remainingMinutes}m`;
}

function warningThreshold(): number {
  return vscode.workspace
    .getConfiguration('multiTerm.usage')
    .get('warningThreshold', 80);
}

function criticalThreshold(): number {
  return vscode.workspace
    .getConfiguration('multiTerm.usage')
    .get('criticalThreshold', 95);
}

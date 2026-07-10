import * as path from 'node:path';
import * as vscode from 'vscode';

type ReviewKind = 'group' | 'image' | 'plan';

export class ReviewTreeItem extends vscode.TreeItem {
  public constructor(
    public readonly kind: ReviewKind,
    label: string,
    public readonly uri?: vscode.Uri,
    public readonly modifiedAt?: number,
    count?: number
  ) {
    super(
      label,
      kind === 'group'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    if (kind === 'group') {
      this.description = `${count ?? 0}`;
      this.iconPath = new vscode.ThemeIcon(label === 'Recent Images' ? 'file-media' : 'notebook');
    } else if (uri) {
      this.resourceUri = uri;
      this.description = path.dirname(vscode.workspace.asRelativePath(uri, false));
      this.tooltip = `${uri.fsPath}\nModified ${new Date(modifiedAt ?? 0).toLocaleString()}`;
      this.iconPath = new vscode.ThemeIcon(kind === 'image' ? 'file-media' : 'markdown');
      this.command = {
        command: 'multiTerm.openReviewItem',
        title: 'Open Review Item',
        arguments: [this]
      };
    }
  }
}

export class ReviewTreeProvider
  implements vscode.TreeDataProvider<ReviewTreeItem>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly watchers: vscode.FileSystemWatcher[];
  private images: ReviewTreeItem[] = [];
  private plans: ReviewTreeItem[] = [];
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor() {
    this.watchers = [
      vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg,gif,webp}'),
      vscode.workspace.createFileSystemWatcher('**/*.{md,mdx}')
    ];
    for (const watcher of this.watchers) {
      watcher.onDidCreate(() => void this.refresh());
      watcher.onDidChange(() => void this.refresh());
      watcher.onDidDelete(() => void this.refresh());
    }
  }

  public async initialize(): Promise<void> {
    await this.refresh();
  }

  public getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: ReviewTreeItem): ReviewTreeItem[] {
    if (!element) {
      return [
        new ReviewTreeItem('group', 'Recent Images', undefined, undefined, this.images.length),
        new ReviewTreeItem('group', 'Plans & Docs', undefined, undefined, this.plans.length)
      ];
    }
    return element.label === 'Recent Images' ? this.images : this.plans;
  }

  public async refresh(): Promise<void> {
    const config = vscode.workspace.getConfiguration('multiTerm.review');
    const max = config.get<number>('maxItemsPerGroup', 12);
    const [imageUris, planUris] = await Promise.all([
      vscode.workspace.findFiles(
        config.get<string>('imageGlob', '**/*.{png,jpg,jpeg,gif,webp}'),
        '**/{node_modules,.git,out,dist}/**',
        max * 4
      ),
      vscode.workspace.findFiles(
        config.get<string>('planGlob', '**/{plans,docs}/**/*.{md,mdx}'),
        '**/{node_modules,.git,out,dist}/**',
        max * 4
      )
    ]);
    const [images, plans] = await Promise.all([
      toItems('image', imageUris, max),
      toItems('plan', planUris, max)
    ]);
    this.images = images;
    this.plans = plans;
    this.changedEmitter.fire();
  }

  public dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.changedEmitter.dispose();
  }
}

async function toItems(
  kind: Exclude<ReviewKind, 'group'>,
  uris: readonly vscode.Uri[],
  max: number
): Promise<ReviewTreeItem[]> {
  const values = await Promise.all(
    uris.map(async (uri) => ({ uri, stat: await vscode.workspace.fs.stat(uri) }))
  );
  return values
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, max)
    .map(({ uri, stat }) => new ReviewTreeItem(kind, path.basename(uri.fsPath), uri, stat.mtime));
}

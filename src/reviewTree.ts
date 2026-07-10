import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  listWorkspaceChanges,
  readBaselineFile,
  type WorkspaceChange
} from './gitReview';
import type { SessionManager } from './sessionManager';
import type { AgentSession } from './types';

const BASELINE_SCHEME = 'multiterm-baseline';
type ReviewKind =
  | 'group'
  | 'image'
  | 'plan'
  | 'change'
  | 'diagnostic'
  | 'message';
type ReviewGroup = 'changes' | 'diagnostics' | 'images' | 'plans';

interface ReviewTreeItemOptions {
  readonly group?: ReviewGroup;
  readonly uri?: vscode.Uri;
  readonly modifiedAt?: number;
  readonly count?: number;
  readonly change?: WorkspaceChange;
  readonly sessionId?: string;
  readonly description?: string;
  readonly diagnostic?: vscode.Diagnostic;
}

export class ReviewTreeItem extends vscode.TreeItem {
  public readonly group?: ReviewGroup;
  public readonly uri?: vscode.Uri;
  public readonly modifiedAt?: number;
  public readonly change?: WorkspaceChange;
  public readonly sessionId?: string;
  public readonly diagnostic?: vscode.Diagnostic;

  public constructor(
    public readonly kind: ReviewKind,
    label: string,
    options: ReviewTreeItemOptions = {}
  ) {
    super(
      label,
      kind === 'group'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.group = options.group;
    this.uri = options.uri;
    this.modifiedAt = options.modifiedAt;
    this.change = options.change;
    this.sessionId = options.sessionId;
    this.diagnostic = options.diagnostic;

    if (kind === 'group') {
      this.description = `${options.count ?? 0}`;
      this.iconPath = groupIcon(options.group);
      return;
    }
    if (kind === 'message') {
      this.description = options.description;
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }
    if (kind === 'change' && options.change && options.uri) {
      this.resourceUri = options.change.kind === 'deleted' ? undefined : options.uri;
      this.description = `${changeLabel(options.change)} · ${directoryLabel(options.change.path)}`;
      this.tooltip = changeTooltip(options.change);
      this.iconPath = new vscode.ThemeIcon(
        options.change.kind === 'deleted' ? 'trash' : 'diff'
      );
      this.command = openCommand(this);
      return;
    }
    if (kind === 'diagnostic' && options.diagnostic && options.uri) {
      this.resourceUri = options.uri;
      this.description = `${diagnosticSeverity(options.diagnostic.severity)} · ${
        vscode.workspace.asRelativePath(options.uri, false)
      }:${options.diagnostic.range.start.line + 1}`;
      this.tooltip = options.diagnostic.message;
      this.iconPath = diagnosticIcon(options.diagnostic.severity);
      this.command = openCommand(this);
      return;
    }
    if (options.uri) {
      this.resourceUri = options.uri;
      this.description = path.dirname(
        vscode.workspace.asRelativePath(options.uri, false)
      );
      this.tooltip = `${options.uri.fsPath}\nModified ${new Date(
        options.modifiedAt ?? 0
      ).toLocaleString()}`;
      this.iconPath = new vscode.ThemeIcon(
        kind === 'image' ? 'file-media' : 'markdown'
      );
      this.command = openCommand(this);
    }
  }
}

export class ReviewTreeProvider
  implements
    vscode.TreeDataProvider<ReviewTreeItem>,
    vscode.TextDocumentContentProvider,
    vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly contentChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly watchers: vscode.FileSystemWatcher[];
  private readonly disposables: vscode.Disposable[] = [];
  private changes: ReviewTreeItem[] = [];
  private diagnostics: ReviewTreeItem[] = [];
  private images: ReviewTreeItem[] = [];
  private plans: ReviewTreeItem[] = [];
  private changeMessage = 'Select an agent with a Git baseline to review changes';
  private refreshGeneration = 0;
  private changeGeneration = 0;
  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly onDidChange = this.contentChangedEmitter.event;

  public constructor(private readonly sessions: SessionManager) {
    this.watchers = [
      vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg,gif,webp}'),
      vscode.workspace.createFileSystemWatcher('**/*.{md,mdx}')
    ];
    for (const watcher of this.watchers) {
      watcher.onDidCreate(() => void this.refresh());
      watcher.onDidChange(() => void this.refresh());
      watcher.onDidDelete(() => void this.refresh());
    }
    this.disposables.push(
      sessions.onDidSelectSession(() => void this.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => void this.refreshChanges()),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics())
    );
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
        new ReviewTreeItem('group', 'Workspace Changes', {
          group: 'changes',
          count: this.changes.length
        }),
        new ReviewTreeItem('group', 'Problems', {
          group: 'diagnostics',
          count: this.diagnostics.length
        }),
        new ReviewTreeItem('group', 'Recent Images', {
          group: 'images',
          count: this.images.length
        }),
        new ReviewTreeItem('group', 'Plans & Docs', {
          group: 'plans',
          count: this.plans.length
        })
      ];
    }
    switch (element.group) {
      case 'changes':
        return this.changes.length > 0
          ? this.changes
          : [
              new ReviewTreeItem('message', this.changeMessage, {
                description: this.sessions.selectedSession?.label
              })
            ];
      case 'images':
        return this.images;
      case 'diagnostics':
        return this.diagnostics;
      case 'plans':
        return this.plans;
      default:
        return [];
    }
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const changeGeneration = ++this.changeGeneration;
    const config = vscode.workspace.getConfiguration('multiTerm.review');
    const max = config.get<number>('maxItemsPerGroup', 12);
    const session = this.sessions.selectedSession;
    const [imageUris, planUris, changes] = await Promise.all([
      vscode.workspace.findFiles(
        config.get<string>('imageGlob', '**/*.{png,jpg,jpeg,gif,webp}'),
        '**/{node_modules,.git,out,dist}/**',
        max * 8
      ),
      vscode.workspace.findFiles(
        config.get<string>('planGlob', '**/{plans,docs}/**/*.{md,mdx}'),
        '**/{node_modules,.git,out,dist}/**',
        max * 8
      ),
      loadChanges(session)
    ]);
    const [images, plans] = await Promise.all([
      toArtifactItems('image', imageUris, max, session),
      toArtifactItems('plan', planUris, max, session)
    ]);
    if (generation !== this.refreshGeneration) {
      return;
    }
    this.images = images;
    this.plans = plans;
    this.diagnostics = toDiagnosticItems(session, max);
    if (changeGeneration === this.changeGeneration) {
      this.applyChanges(session, changes);
    }
    this.changedEmitter.fire();
  }

  public async refreshChanges(): Promise<void> {
    const generation = ++this.changeGeneration;
    const session = this.sessions.selectedSession;
    const changes = await loadChanges(session);
    if (generation !== this.changeGeneration) {
      return;
    }
    this.applyChanges(session, changes);
    this.changedEmitter.fire();
  }

  public refreshDiagnostics(): void {
    const max = vscode.workspace
      .getConfiguration('multiTerm.review')
      .get<number>('maxItemsPerGroup', 12);
    this.diagnostics = toDiagnosticItems(this.sessions.selectedSession, max);
    this.changedEmitter.fire();
  }

  public async open(item: ReviewTreeItem): Promise<void> {
    if (item.kind === 'change') {
      await this.openChange(item);
      return;
    }
    if (item.kind === 'diagnostic' && item.uri && item.diagnostic) {
      const document = await vscode.workspace.openTextDocument(item.uri);
      await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preview: true,
        selection: item.diagnostic.range
      });
      return;
    }
    if (item.uri) {
      await vscode.commands.executeCommand('vscode.open', item.uri, {
        viewColumn: vscode.ViewColumn.One,
        preview: true
      });
    }
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const session = this.sessions.get(uri.authority);
    if (!session?.baseline) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const query = new URLSearchParams(uri.query);
    if (query.get('empty') === '1') {
      return '';
    }
    const baselinePath = query.get('baselinePath') ?? uri.path.slice(1);
    return readBaselineFile(session.baseline, baselinePath);
  }

  public dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
    this.contentChangedEmitter.dispose();
  }

  private applyChanges(
    session: AgentSession | undefined,
    changes: readonly WorkspaceChange[] | undefined
  ): void {
    if (!session?.baseline) {
      this.changes = [];
      this.changeMessage = session
        ? 'This agent was launched outside a Git repository'
        : 'Select an agent with a Git baseline to review changes';
      return;
    }
    if (!changes) {
      this.changes = [];
      this.changeMessage = 'Git changes could not be read';
      return;
    }
    this.changes = changes.map((change) =>
      new ReviewTreeItem('change', path.basename(change.path), {
        change,
        sessionId: session.id,
        uri: vscode.Uri.file(path.join(session.baseline!.repoRoot, change.path))
      })
    );
    this.changeMessage = 'No workspace changes from the captured commit';
  }

  private async openChange(item: ReviewTreeItem): Promise<void> {
    const session = item.sessionId ? this.sessions.get(item.sessionId) : undefined;
    const change = item.change;
    if (!session?.baseline || !change || !item.uri) {
      return;
    }
    if (isImage(change.path)) {
      if (change.kind === 'deleted') {
        const choice = await vscode.window.showInformationMessage(
          `Deleted image: ${change.path}`,
          'Open Source Control'
        );
        if (choice) {
          await vscode.commands.executeCommand('workbench.view.scm');
        }
      } else {
        await vscode.commands.executeCommand('vscode.open', item.uri, {
          viewColumn: vscode.ViewColumn.One,
          preview: true
        });
      }
      return;
    }
    const hasBaseline = change.kind !== 'added' && change.kind !== 'untracked';
    const baselineUri = vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      authority: session.id,
      path: `/${change.path}`,
      query: hasBaseline
        ? change.previousPath
          ? `baselinePath=${encodeURIComponent(change.previousPath)}`
          : ''
        : 'empty=1'
    });
    if (change.kind === 'deleted') {
      const emptyWorkingUri = vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        authority: session.id,
        path: `/${change.path}`,
        query: 'empty=1&side=working'
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        baselineUri,
        emptyWorkingUri,
        `${change.path} (deleted · ${session.label})`,
        { viewColumn: vscode.ViewColumn.One, preview: true }
      );
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      baselineUri,
      item.uri,
      `${change.path} (${session.label})`,
      { viewColumn: vscode.ViewColumn.One, preview: true }
    );
  }
}

async function loadChanges(
  session: AgentSession | undefined
): Promise<WorkspaceChange[] | undefined> {
  if (!session?.baseline) {
    return [];
  }
  try {
    return await listWorkspaceChanges(session.baseline);
  } catch {
    return undefined;
  }
}

async function toArtifactItems(
  kind: 'image' | 'plan',
  uris: readonly vscode.Uri[],
  max: number,
  session: AgentSession | undefined
): Promise<ReviewTreeItem[]> {
  const values = (
    await Promise.all(
      uris.map(async (uri) => {
        try {
          return { uri, stat: await vscode.workspace.fs.stat(uri) };
        } catch {
          return undefined;
        }
      })
    )
  ).filter(
    (value): value is { uri: vscode.Uri; stat: vscode.FileStat } =>
      value !== undefined
  );
  const root = session?.baseline?.repoRoot ?? session?.cwd;
  return values
    .filter(({ uri, stat }) => {
      if (!session || !root) {
        return true;
      }
      return isWithin(root, uri.fsPath) && stat.mtime >= session.createdAt;
    })
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, max)
    .map(
      ({ uri, stat }) =>
        new ReviewTreeItem(kind, path.basename(uri.fsPath), {
          uri,
          modifiedAt: stat.mtime
        })
    );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isImage(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(filePath);
}

function groupIcon(group: ReviewGroup | undefined): vscode.ThemeIcon {
  switch (group) {
    case 'changes':
      return new vscode.ThemeIcon('git-compare');
    case 'images':
      return new vscode.ThemeIcon('file-media');
    case 'diagnostics':
      return new vscode.ThemeIcon('warning');
    default:
      return new vscode.ThemeIcon('notebook');
  }
}

function toDiagnosticItems(
  session: AgentSession | undefined,
  max: number
): ReviewTreeItem[] {
  const root = session?.baseline?.repoRoot ?? session?.cwd;
  return vscode.languages
    .getDiagnostics()
    .flatMap(([uri, diagnostics]) =>
      diagnostics.map((diagnostic) => ({ uri, diagnostic }))
    )
    .filter(({ uri }) => uri.scheme === 'file' && (!root || isWithin(root, uri.fsPath)))
    .sort((left, right) => left.diagnostic.severity - right.diagnostic.severity)
    .slice(0, max)
    .map(
      ({ uri, diagnostic }) =>
        new ReviewTreeItem(
          'diagnostic',
          diagnostic.message.split(/\r?\n/, 1)[0].slice(0, 140),
          { uri, diagnostic }
        )
    );
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
  }
}

function diagnosticIcon(severity: vscode.DiagnosticSeverity): vscode.ThemeIcon {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return new vscode.ThemeIcon(
        'error',
        new vscode.ThemeColor('list.errorForeground')
      );
    case vscode.DiagnosticSeverity.Warning:
      return new vscode.ThemeIcon(
        'warning',
        new vscode.ThemeColor('list.warningForeground')
      );
    default:
      return new vscode.ThemeIcon('info');
  }
}

function openCommand(item: ReviewTreeItem): vscode.Command {
  return {
    command: 'multiTerm.openReviewItem',
    title: 'Open Review Item',
    arguments: [item]
  };
}

function changeLabel(change: WorkspaceChange): string {
  return change.kind === 'untracked'
    ? 'untracked'
    : `${change.kind} (${change.statusCode})`;
}

function directoryLabel(filePath: string): string {
  const directory = path.dirname(filePath);
  return directory === '.' ? 'repository root' : directory;
}

function changeTooltip(change: WorkspaceChange): string {
  return change.previousPath
    ? `${change.kind}: ${change.previousPath} → ${change.path}`
    : `${change.kind}: ${change.path}`;
}

import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  artifactTypeLabel,
  classifyArtifact
} from './artifactClassification';
import {
  excludeWorkspaceArtifacts,
  listWorkspaceChanges,
  readBaselineFile,
  readGitWorktreeState,
  type GitWorktreeState,
  type WorkspaceChange
} from './gitReview';
import type { SessionManager } from './sessionManager';
import type { AgentSession } from './types';

const BASELINE_SCHEME = 'parful-baseline';
type ReviewKind =
  | 'group'
  | 'image'
  | 'plan'
  | 'change'
  | 'worktree'
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
  readonly worktreeKey?: string;
  readonly tooltip?: string;
  readonly warning?: boolean;
}

interface WorktreeChanges {
  readonly key: string;
  readonly session: AgentSession;
  readonly agentLabels: readonly string[];
  readonly agentDetails: readonly string[];
  readonly changes: readonly WorkspaceChange[] | undefined;
  readonly state: GitWorktreeState;
}

export class ReviewTreeItem extends vscode.TreeItem {
  public readonly group?: ReviewGroup;
  public readonly uri?: vscode.Uri;
  public readonly modifiedAt?: number;
  public readonly change?: WorkspaceChange;
  public readonly sessionId?: string;
  public readonly diagnostic?: vscode.Diagnostic;
  public readonly worktreeKey?: string;

  public constructor(
    public readonly kind: ReviewKind,
    label: string,
    options: ReviewTreeItemOptions = {}
  ) {
    super(
      label,
      kind === 'group'
        ? vscode.TreeItemCollapsibleState.Expanded
        : kind === 'worktree'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
    );
    this.group = options.group;
    this.uri = options.uri;
    this.modifiedAt = options.modifiedAt;
    this.change = options.change;
    this.sessionId = options.sessionId;
    this.diagnostic = options.diagnostic;
    this.worktreeKey = options.worktreeKey;

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
    if (kind === 'worktree') {
      this.description = options.description;
      this.tooltip = options.tooltip;
      this.iconPath = options.warning
        ? new vscode.ThemeIcon(
            'warning',
            new vscode.ThemeColor('list.warningForeground')
          )
        : new vscode.ThemeIcon('git-branch');
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
      this.description =
        options.description ??
        path.dirname(vscode.workspace.asRelativePath(options.uri, false));
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
  private changeGroups: ReviewTreeItem[] = [];
  private readonly changesByWorktree = new Map<string, ReviewTreeItem[]>();
  private changeCount = 0;
  private diagnostics: ReviewTreeItem[] = [];
  private images: ReviewTreeItem[] = [];
  private plans: ReviewTreeItem[] = [];
  private planPaths = new Set<string>();
  private changeMessage = 'Select an agent with a Git baseline to review changes';
  private refreshGeneration = 0;
  private changeGeneration = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly onDidChange = this.contentChangedEmitter.event;

  public constructor(private readonly sessions: SessionManager) {
    const imageWatcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{png,jpg,jpeg,gif,webp}'
    );
    const planWatcher = vscode.workspace.createFileSystemWatcher('**/*.{md,mdx}');
    this.watchers = [imageWatcher, planWatcher];
    imageWatcher.onDidCreate(() => this.refreshImagesIfEnabled());
    imageWatcher.onDidChange(() => this.refreshImagesIfEnabled());
    imageWatcher.onDidDelete(() => this.refreshImagesIfEnabled());
    planWatcher.onDidCreate(() => void this.refresh());
    planWatcher.onDidChange(() => void this.refresh());
    planWatcher.onDidDelete(() => void this.refresh());
    this.disposables.push(
      sessions.onDidSelectSession(() => this.scheduleRefresh()),
      sessions.onDidChange(() => this.scheduleRefresh()),
      sessions.onDidChangeTopology(() => this.scheduleRefresh()),
      vscode.workspace.onDidSaveTextDocument(() => void this.refreshChanges()),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('parful.review')) {
          void this.refresh();
        }
      })
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
      const groups = [
        new ReviewTreeItem('group', 'Workspace Changes', {
          group: 'changes',
          count: this.changeCount
        }),
        new ReviewTreeItem('group', 'Problems', {
          group: 'diagnostics',
          count: this.diagnostics.length
        }),
        new ReviewTreeItem('group', 'Plans & Docs', {
          group: 'plans',
          count: this.plans.length
        })
      ];
      if (imagesEnabled()) {
        groups.splice(
          2,
          0,
          new ReviewTreeItem('group', 'Recent Images', {
            group: 'images',
            count: this.images.length
          })
        );
      }
      return groups;
    }
    if (element.kind === 'worktree' && element.worktreeKey) {
      return this.changesByWorktree.get(element.worktreeKey) ?? [];
    }
    switch (element.group) {
      case 'changes':
        return this.changeGroups.length > 0
          ? this.changeGroups
          : [
              new ReviewTreeItem('message', this.changeMessage, {
                description: 'Launch an agent in a Git worktree'
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
    const config = vscode.workspace.getConfiguration('parful.review');
    const max = config.get<number>('maxItemsPerGroup', 12);
    const showImages = config.get<boolean>('showRecentImages', false);
    const session = this.sessions.selectedSession;
    const [imageUris, planUris, worktreeChanges] = await Promise.all([
      showImages
        ? findFilesAcrossAgentRoots(
            this.sessions,
            [config.get<string>('imageGlob', '**/*.{png,jpg,jpeg,gif,webp}')],
            '**/{node_modules,.git,out,dist}/**',
            max * 8
          )
        : Promise.resolve([]),
      findFilesAcrossAgentRoots(
        this.sessions,
        config.get<string[]>('artifactGlobs', [
          '**/{plans,docs}/**/*.{md,mdx}',
          '**/todos/**/*.{md,mdx}',
          '**/{TODOS,DESIGN}.{md,mdx}'
        ]),
        '**/{node_modules,.git,out,dist}/**'
      ),
      loadWorktreeChanges(this.sessions)
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
    this.planPaths = new Set(planUris.map((uri) => uri.fsPath));
    this.diagnostics = toDiagnosticItems(session, max);
    if (changeGeneration === this.changeGeneration) {
      this.applyWorktreeChanges(worktreeChanges);
    }
    this.changedEmitter.fire();
  }

  private refreshImagesIfEnabled(): void {
    if (imagesEnabled()) {
      void this.refresh();
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  public async refreshChanges(): Promise<void> {
    const generation = ++this.changeGeneration;
    const worktreeChanges = await loadWorktreeChanges(this.sessions);
    if (generation !== this.changeGeneration) {
      return;
    }
    this.applyWorktreeChanges(worktreeChanges);
    this.changedEmitter.fire();
  }

  public refreshDiagnostics(): void {
    const max = vscode.workspace
      .getConfiguration('parful.review')
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
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
    this.contentChangedEmitter.dispose();
  }

  private applyWorktreeChanges(worktrees: readonly WorktreeChanges[]): void {
    this.changeGroups = [];
    this.changeCount = 0;
    this.changesByWorktree.clear();
    if (worktrees.length === 0) {
      this.changeMessage = 'No open agents have a Git worktree baseline';
      return;
    }

    for (const worktree of worktrees) {
      const baseline = worktree.session.baseline!;
      const branchChanged = worktree.state.branch !== baseline.branch;
      const changes = worktree.changes
        ? excludeWorkspaceArtifacts(
            worktree.changes,
            baseline.repoRoot,
            this.planPaths
          )
        : undefined;
      const changeItems = changes
        ? changes.length > 0
          ? changes.map(
              (change) =>
                new ReviewTreeItem('change', path.basename(change.path), {
                  change,
                  sessionId: worktree.session.id,
                  uri: vscode.Uri.file(
                    path.join(baseline.repoRoot, change.path)
                  )
                })
            )
          : [new ReviewTreeItem('message', 'No workspace changes')]
        : [new ReviewTreeItem('message', 'Git changes could not be read')];
      const childItems = branchChanged
        ? [
            new ReviewTreeItem('message', 'Branch changed since agent launch', {
              description: `${branchLabel(baseline.branch, baseline.commit)} → ${branchLabel(
                worktree.state.branch,
                worktree.state.commit
              )} · captured baseline is stale`
            }),
            ...changeItems
          ]
        : changeItems;
      this.changesByWorktree.set(worktree.key, childItems);
      this.changeCount += changes?.length ?? 0;
      this.changeGroups.push(
        new ReviewTreeItem(
          'worktree',
          `${worktree.agentLabels.join(' + ')} · ${worktree.state.repositoryName}`,
          {
            worktreeKey: worktree.key,
            description: `${
              branchChanged
                ? `${branchLabel(baseline.branch, baseline.commit)} → ${branchLabel(
                    worktree.state.branch,
                    worktree.state.commit
                  )}`
                : branchLabel(worktree.state.branch, worktree.state.commit)
            } · ${changes?.length ?? 0} changes`,
            warning: branchChanged,
            tooltip: [
              baseline.repoRoot,
              `Agents: ${worktree.agentDetails.join(', ')}`,
              `Launch baseline: ${baseline.branch} @ ${baseline.commit}`,
              `Current branch: ${worktree.state.branch} @ ${worktree.state.commit}`,
              ...(branchChanged
                ? ['Warning: branch changed; the captured diff baseline is stale.']
                : [])
            ].join('\n')
          }
        )
      );
    }
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

async function loadWorktreeChanges(
  sessions: SessionManager
): Promise<WorktreeChanges[]> {
  const sessionsByWorktree = new Map<string, AgentSession[]>();
  for (const session of sessions.list()) {
    if (!session.baseline || !sessions.isOpen(session.id)) {
      continue;
    }
    const key = path.resolve(session.baseline.repoRoot);
    const existing = sessionsByWorktree.get(key) ?? [];
    existing.push(session);
    sessionsByWorktree.set(key, existing);
  }

  return Promise.all(
    [...sessionsByWorktree.entries()].map(async ([key, attachedSessions]) => {
      const sorted = attachedSessions.sort(
        (left, right) => right.createdAt - left.createdAt
      );
      const session = sorted[0];
      let changes: WorkspaceChange[] | undefined;
      let state: GitWorktreeState = {
        repoRoot: session.baseline!.repoRoot,
        repositoryName: path.basename(session.baseline!.repoRoot),
        commit: session.baseline!.commit,
        branch: session.baseline!.branch
      };
      try {
        changes = await listWorkspaceChanges(session.baseline!);
      } catch {
        changes = undefined;
      }
      try {
        state = await readGitWorktreeState(session.baseline!.repoRoot);
      } catch {
        // Keep the launch baseline as an honest fallback while retaining changes.
      }
      return {
        key,
        session,
        agentLabels: sorted.map((attached) => attached.label),
        agentDetails: sorted.map(
          (attached) => `${attached.label} (${attached.kind})`
        ),
        changes,
        state
      };
    })
  );
}

async function findFilesAcrossAgentRoots(
  sessions: SessionManager,
  includes: readonly string[],
  exclude: string,
  maxResultsPerRoot?: number
): Promise<vscode.Uri[]> {
  const roots = new Map<string, vscode.Uri>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    roots.set(normalizeRootKey(folder.uri.fsPath), folder.uri);
  }
  for (const session of sessions.list()) {
    const root = session.baseline?.repoRoot ?? session.cwd;
    const resolved = path.resolve(root);
    roots.set(normalizeRootKey(resolved), vscode.Uri.file(resolved));
  }

  const matches = await Promise.all(
    [...roots.values()].flatMap((root) => includes.map(async (include) => {
      try {
        return await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, include),
          exclude,
          maxResultsPerRoot
        );
      } catch {
        return [];
      }
    }))
  );
  const unique = new Map<string, vscode.Uri>();
  for (const uri of matches.flat()) {
    unique.set(normalizeRootKey(uri.fsPath), uri);
  }
  return [...unique.values()];
}

function normalizeRootKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function branchLabel(branch: string, commit: string): string {
  return branch === 'HEAD' ? `detached@${commit.slice(0, 7)}` : branch;
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
      return (
        isWithin(root, uri.fsPath) &&
        (kind === 'plan' || stat.mtime >= session.createdAt)
      );
    })
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, max)
    .map(({ uri, stat }) => {
      const relativePath = root && isWithin(root, uri.fsPath)
        ? path.relative(root, uri.fsPath)
        : vscode.workspace.asRelativePath(uri, false);
      const directory = path.dirname(relativePath);
      const description = kind === 'plan'
        ? `${artifactTypeLabel(classifyArtifact(relativePath))} · ${
            directory === '.' ? 'repository root' : directory
          }`
        : directory;
      return new ReviewTreeItem(kind, path.basename(uri.fsPath), {
          uri,
          modifiedAt: stat.mtime,
          description
        });
    });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isImage(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(filePath);
}

function imagesEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('parful.review')
    .get('showRecentImages', false);
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
    command: 'parful.openReviewItem',
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

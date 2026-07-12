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
import type { AgentSession, CommandResult } from './types';

const BASELINE_SCHEME = 'lookout-baseline';
const COMMAND_RESULT_SCHEME = 'lookout-command-result';
type ReviewKind =
  | 'group'
  | 'image'
  | 'plan'
  | 'change'
  | 'worktree'
  | 'artifact-worktree'
  | 'diagnostic'
  | 'runtime'
  | 'command-result'
  | 'message';
type ReviewGroup =
  | 'changes'
  | 'diagnostics'
  | 'images'
  | 'plans'
  | 'runtime'
  | 'results';

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
  readonly command?: vscode.Command;
}

interface WorktreeChanges {
  readonly key: string;
  readonly session: AgentSession;
  readonly sessions: readonly AgentSession[];
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
        : kind === 'worktree' || kind === 'artifact-worktree'
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
    if (kind === 'runtime' || kind === 'command-result') {
      this.description = options.description;
      this.tooltip = options.tooltip;
      this.iconPath = new vscode.ThemeIcon(
        options.command?.command === 'workbench.view.debug'
          ? 'debug-alt'
          : 'pulse'
      );
      this.command = options.command;
      return;
    }
    if (kind === 'worktree' || kind === 'artifact-worktree') {
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
  private runtime: ReviewTreeItem[] = [];
  private commandResults: ReviewTreeItem[] = [];
  private images: ReviewTreeItem[] = [];
  private plans: ReviewTreeItem[] = [];
  private planCount = 0;
  private readonly plansByWorktree = new Map<string, ReviewTreeItem[]>();
  private planPaths = new Set<string>();
  private changeMessage = 'Select an agent with a Git baseline to review changes';
  // Beyond this, a tree stops being reviewable; Source Control owns the full
  // surface (D1). Keeps a stray node_modules/.venv from rendering thousands
  // of rows every refresh tick.
  private static readonly maxChangesPerWorktree = 100;
  private refreshGeneration = 0;
  private changeGeneration = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private worktreeRefreshTimer: NodeJS.Timeout | undefined;
  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly onDidChange = this.contentChangedEmitter.event;

  public constructor(private readonly sessions: SessionManager) {
    const imageWatcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{png,jpg,jpeg,gif,webp}'
    );
    const planWatcher = vscode.workspace.createFileSystemWatcher('**/*.{md,mdx,txt}');
    this.watchers = [imageWatcher, planWatcher];
    // Agents stream writes into plan/doc files; every fs event running an
    // un-debounced refresh (findFiles plus git per worktree) would keep the
    // whole pipeline busy. The 250 ms debounce coalesces the bursts.
    imageWatcher.onDidCreate(() => this.refreshImagesIfEnabled());
    imageWatcher.onDidChange(() => this.refreshImagesIfEnabled());
    imageWatcher.onDidDelete(() => this.refreshImagesIfEnabled());
    planWatcher.onDidCreate(() => this.scheduleRefresh());
    planWatcher.onDidChange(() => this.scheduleRefresh());
    planWatcher.onDidDelete(() => this.scheduleRefresh());
    this.disposables.push(
      sessions.onDidSelectSession(() => this.scheduleRefresh()),
      sessions.onDidChange(() => {
        this.scheduleRefresh();
        this.refreshRuntime();
      }),
      sessions.onDidChangeTopology(() => this.scheduleRefresh()),
      vscode.workspace.onDidSaveTextDocument(() => void this.refreshChanges()),
      vscode.languages.onDidChangeDiagnostics(() => this.refreshDiagnostics()),
      vscode.tasks.onDidStartTask(() => this.refreshRuntime()),
      vscode.tasks.onDidEndTask(() => this.refreshRuntime()),
      vscode.debug.onDidStartDebugSession(() => this.refreshRuntime()),
      vscode.debug.onDidTerminateDebugSession(() => this.refreshRuntime()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('lookout.review')) {
          void this.refresh();
        }
      })
    );
  }

  public async initialize(): Promise<void> {
    await this.refresh();
    this.refreshRuntime();
    this.worktreeRefreshTimer = setInterval(
      () => void this.refreshChanges(),
      10_000
    );
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
        new ReviewTreeItem('group', 'Running', {
          group: 'runtime',
          count: this.runtime.length
        }),
        ...(this.commandResults.length > 0
          ? [
              new ReviewTreeItem('group', 'Recent Command Results', {
                group: 'results',
                count: this.commandResults.length
              })
            ]
          : []),
        new ReviewTreeItem('group', 'Plans & Docs', {
          group: 'plans',
          count: this.planCount
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
    if (element.kind === 'artifact-worktree' && element.worktreeKey) {
      return this.plansByWorktree.get(element.worktreeKey) ?? [];
    }
    switch (element.group) {
      case 'changes':
        return this.changeGroups.length > 0
          ? this.changeGroups
          : [
              new ReviewTreeItem('message', this.changeMessage, {
                description: 'Launch an agent inside a Git repository'
              })
            ];
      case 'images':
        return this.images;
      case 'diagnostics':
        return this.diagnostics;
      case 'plans':
        return this.plans;
      case 'runtime':
        return this.runtime.length > 0
          ? this.runtime
          : [
              new ReviewTreeItem(
                'message',
                'Nothing running',
                { description: 'Agent commands, tasks, and debug sessions appear here' }
              )
            ];
      case 'results':
        return this.commandResults;
      default:
        return [];
    }
  }

  public async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const changeGeneration = ++this.changeGeneration;
    const config = vscode.workspace.getConfiguration('lookout.review');
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
          '**/{plans,docs}/**/*.{md,mdx,txt}',
          '**/todos/**/*.{md,mdx,txt}',
          '**/{TODOS,DESIGN,TESTPLAN}.{md,mdx,txt}'
        ]),
        '**/{node_modules,.git,out,dist}/**'
      ),
      loadWorktreeChanges(this.sessions)
    ]);
    const [images, planArtifacts] = await Promise.all([
      toArtifactItems('image', imageUris, max, session),
      toChangedPlanItems(planUris, worktreeChanges, max)
    ]);
    if (generation !== this.refreshGeneration) {
      return;
    }
    this.images = images;
    this.plans = planArtifacts.groups;
    this.planCount = planArtifacts.paths.size;
    this.plansByWorktree.clear();
    for (const [key, items] of planArtifacts.itemsByWorktree) {
      this.plansByWorktree.set(key, items);
    }
    this.planPaths = planArtifacts.paths;
    this.diagnostics = toDiagnosticItems(session, max);
    if (changeGeneration === this.changeGeneration) {
      this.applyWorktreeChanges(worktreeChanges);
    }
    this.changedEmitter.fire();
  }

  private refreshImagesIfEnabled(): void {
    if (imagesEnabled()) {
      this.scheduleRefresh();
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
      .getConfiguration('lookout.review')
      .get<number>('maxItemsPerGroup', 12);
    this.diagnostics = toDiagnosticItems(this.sessions.selectedSession, max);
    this.changedEmitter.fire();
  }

  public refreshRuntime(): void {
    const items: ReviewTreeItem[] = [];
    const results: ReviewTreeItem[] = [];
    // Agent-run shell commands first: this is what a reviewer actually cares
    // about (builds, tests, dev servers the agents are running right now).
    for (const session of this.sessions.list()) {
      for (const running of session.runningCommands) {
        items.push(
          new ReviewTreeItem('runtime', running.command, {
            sessionId: session.id,
            description: session.label,
            tooltip: `${running.command}\n\n${session.label}`,
            command: {
              command: 'lookout.focusSession',
              title: 'Focus Agent',
              arguments: [{ session: { id: session.id } }]
            }
          })
        );
      }
      for (const result of this.sessions.commandResultsFor(session.id)) {
        results.push(commandResultItem(session, result));
      }
    }
    const debugSession = vscode.debug.activeDebugSession;
    if (debugSession) {
      items.push(
        new ReviewTreeItem('runtime', debugSession.name, {
          description: `debug · ${debugSession.type}`,
          command: {
            command: 'workbench.view.debug',
            title: 'Open Run and Debug'
          }
        })
      );
    }
    for (const execution of vscode.tasks.taskExecutions) {
      items.push(
        new ReviewTreeItem('runtime', execution.task.name, {
          description: `task · ${execution.task.source}`,
          command: {
            command: 'workbench.action.tasks.showTasks',
            title: 'Show Running Tasks'
          }
        })
      );
    }
    this.runtime = items;
    this.commandResults = results.sort(
      (left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)
    );
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
    if (uri.scheme === COMMAND_RESULT_SCHEME) {
      const resultId = decodeUriPath(uri.path.slice(1));
      const result = this.sessions
        .commandResultsFor(uri.authority)
        .find((candidate) => candidate.id === resultId);
      if (!result) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      const session = this.sessions.get(uri.authority);
      return commandResultContent(session, result);
    }
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
    if (this.worktreeRefreshTimer) {
      clearInterval(this.worktreeRefreshTimer);
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
      this.changeMessage = 'No open agents have a Git baseline';
      return;
    }

    for (const worktree of worktrees) {
      const baseline = worktree.session.baseline!;
      // Detached checkouts both report the pseudo-branch HEAD, so the commit
      // is the only signal that the captured baseline went stale.
      const branchChanged =
        worktree.state.branch !== baseline.branch ||
        (worktree.state.branch === 'HEAD' &&
          worktree.state.commit !== baseline.commit);
      const changes = worktree.changes
        ? excludeWorkspaceArtifacts(
            worktree.changes,
            baseline.repoRoot,
            this.planPaths
          )
        : undefined;
      const visibleChanges = changes?.slice(
        0,
        ReviewTreeProvider.maxChangesPerWorktree
      );
      const changeItems = changes && visibleChanges
        ? changes.length > 0
          ? [
              ...visibleChanges.map(
                (change) =>
                  new ReviewTreeItem('change', path.basename(change.path), {
                    change,
                    sessionId: worktree.session.id,
                    uri: vscode.Uri.file(
                      path.join(baseline.repoRoot, change.path)
                    )
                  })
              ),
              ...(changes.length > visibleChanges.length
                ? [
                    new ReviewTreeItem(
                      'message',
                      `…${changes.length - visibleChanges.length} more changes`,
                      {
                        description:
                          'Open Source Control for the full list'
                      }
                    )
                  ]
                : [])
            ]
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
        sessions: sorted,
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

async function toChangedPlanItems(
  uris: readonly vscode.Uri[],
  worktrees: readonly WorktreeChanges[],
  max: number
): Promise<{
  groups: ReviewTreeItem[];
  itemsByWorktree: Map<string, ReviewTreeItem[]>;
  paths: Set<string>;
}> {
  const urisByPath = new Map(
    uris.map((uri) => [normalizeRootKey(uri.fsPath), uri] as const)
  );
  const groups: ReviewTreeItem[] = [];
  const itemsByWorktree = new Map<string, ReviewTreeItem[]>();
  const paths = new Set<string>();
  let remaining = max;
  for (const worktree of worktrees) {
    if (!worktree.changes || remaining <= 0) {
      continue;
    }
    const earliestLaunch = Math.min(
      ...worktree.sessions.map((attached) => attached.createdAt)
    );
    const candidates = await Promise.all(
      worktree.changes.map(async (change) => {
        if (change.kind === 'deleted') {
          return undefined;
        }
        const absolutePath = path.join(worktree.state.repoRoot, change.path);
        const uri = urisByPath.get(normalizeRootKey(absolutePath));
        if (!uri) {
          return undefined;
        }
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          return stat.mtime >= earliestLaunch ? { change, uri, stat } : undefined;
        } catch {
          return undefined;
        }
      })
    );
    const eligible = candidates
      .filter(
        (value): value is {
          change: WorkspaceChange;
          uri: vscode.Uri;
          stat: vscode.FileStat;
        } => value !== undefined
      )
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    for (const { uri } of eligible) {
      paths.add(uri.fsPath);
    }
    const values = eligible.slice(0, remaining);
    if (values.length === 0) {
      continue;
    }
    const items = values.map(({ change, uri, stat }) => {
      return new ReviewTreeItem('plan', path.basename(change.path), {
        uri,
        modifiedAt: stat.mtime,
        description: `${artifactTypeLabel(classifyArtifact(change.path))} · ${directoryLabel(change.path)}`
      });
    });
    remaining -= items.length;
    itemsByWorktree.set(worktree.key, items);
    groups.push(
      new ReviewTreeItem(
        'artifact-worktree',
        `${worktree.agentLabels.join(' + ')} · ${worktree.state.repositoryName}`,
        {
          worktreeKey: worktree.key,
          description: `${worktree.state.branch} · ${items.length} artifacts`,
          tooltip: `${worktree.state.repoRoot}\nAgents: ${worktree.agentDetails.join(', ')}`
        }
      )
    );
  }
  return { groups, itemsByWorktree, paths };
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
    .getConfiguration('lookout.review')
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
    case 'runtime':
      return new vscode.ThemeIcon('pulse');
    case 'results':
      return new vscode.ThemeIcon('output');
    default:
      return new vscode.ThemeIcon('notebook');
  }
}

function commandResultItem(
  session: AgentSession,
  result: CommandResult
): ReviewTreeItem {
  const uri = vscode.Uri.from({
    scheme: COMMAND_RESULT_SCHEME,
    authority: session.id,
    path: `/${encodeURIComponent(result.id)}`
  });
  const outcome = result.outcome === 'completed' ? 'completed' : result.outcome;
  const duration = result.durationMs === undefined
    ? ''
    : ` · ${formatDuration(result.durationMs)}`;
  return new ReviewTreeItem('command-result', result.command, {
    uri,
    modifiedAt: result.completedAt,
    description: `${session.label} · ${outcome}${duration}`,
    tooltip: `${result.command}\n\n${session.label} · ${outcome}${duration}`,
    command: {
      command: 'lookout.openReviewItem',
      title: 'Open Command Result',
      arguments: [{ uri, kind: 'command-result' }]
    }
  });
}

function commandResultContent(
  session: AgentSession | undefined,
  result: CommandResult
): string {
  const metadata = [
    `Command: ${result.command}`,
    `Agent: ${session?.label ?? 'Unknown agent'}`,
    `Provider: ${session?.kind ?? 'unknown'}`,
    `Outcome: ${result.outcome}`,
    ...(result.exitCode === undefined ? [] : [`Exit code: ${result.exitCode}`]),
    ...(result.durationMs === undefined ? [] : [`Duration: ${formatDuration(result.durationMs)}`]),
    ...(result.truncated ? ['Output: trailing 8 KiB retained'] : [])
  ];
  return [
    ...metadata,
    '',
    ...(result.stdout ? ['stdout', '------', result.stdout, ''] : []),
    ...(result.stderr ? ['stderr', '------', result.stderr, ''] : []),
    ...(result.error ? ['error', '-----', result.error, ''] : [])
  ].join('\n');
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
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
    command: 'lookout.openReviewItem',
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

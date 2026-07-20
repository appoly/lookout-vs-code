import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  artifactTypeLabel,
  classifyArtifact
} from './artifactClassification';
import {
  excludeWorkspaceArtifacts,
  listGitWorktrees,
  listWorkspaceChanges,
  readBaselineFile,
  readGitWorktreeState,
  type GitWorktreeState,
  type WorkspaceChange
} from './gitReview';
import type { SessionManager } from './sessionManager';
import {
  boundedReviewItemLimit,
  normalizeReviewGlobs,
  reviewSearchResultLimit
} from './reviewSearchPolicy';
import type { AgentSession, CommandResult, GitBaseline } from './types';
import type { ReviewPacket } from './verification/reviewPacket';
import { VerificationManager } from './verification/verificationManager';
import {
  loadVerificationStore,
  persistableVerificationStore,
  VERIFICATION_STORE_VERSION
} from './verification/verificationStoreModel';
import { VscodeDiagnosticEvidenceSource } from './verification/vscodeDiagnosticEvidence';
import { toReviewSessionSnapshots } from './verification/sessionEvidenceAdapter';
import {
  completeTaskVerificationRun,
  restoredTaskVerificationPolicy,
  startTaskVerificationRun,
  taskVerificationPolicy,
  type TaskCompletion,
  type VerificationTaskIdentity,
  type VerificationTaskKind
} from './verification/taskVerification';
import type { ReviewContext } from './verification/verificationTypes';

const BASELINE_SCHEME = 'lookout-baseline';
const COMMAND_RESULT_SCHEME = 'lookout-command-result';
const VERIFICATION_STORE_KEY = 'lookout.verificationStore.v1';
const MAX_REVIEW_ROOTS = 32;
type ReviewKind =
  | 'group'
  | 'image'
  | 'plan'
  | 'change'
  | 'worktree'
  | 'artifact-worktree'
  | 'diagnostic'
  | 'runtime'
  | 'evidence'
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
  readonly activityKind?: 'mcp';
}

interface WorktreeChanges {
  readonly key: string;
  readonly session: AgentSession;
  readonly sessions: readonly AgentSession[];
  readonly baseline: GitBaseline;
  readonly linked: boolean;
  readonly startedAt: number;
  readonly agentLabels: readonly string[];
  readonly agentDetails: readonly string[];
  readonly changes: readonly WorkspaceChange[] | undefined;
  readonly state: GitWorktreeState;
}

type ReviewErrorReporter = (scope: string, error: unknown) => void;

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
    if (kind === 'evidence') {
      this.description = options.description;
      this.tooltip = options.tooltip;
      this.iconPath = options.warning
        ? new vscode.ThemeIcon(
            'warning',
            new vscode.ThemeColor('list.warningForeground')
          )
        : new vscode.ThemeIcon('verified');
      return;
    }
    if (kind === 'runtime' || kind === 'command-result') {
      this.description = options.description;
      this.tooltip = options.tooltip;
      this.iconPath = new vscode.ThemeIcon(
        options.activityKind === 'mcp'
          ? 'extensions'
          : options.command?.command === 'workbench.view.debug'
          ? 'debug-alt'
          : 'pulse'
      );
      this.command = options.command;
      return;
    }
    if (kind === 'worktree' || kind === 'artifact-worktree') {
      this.description = options.description;
      this.tooltip = options.tooltip;
      this.contextValue = kind === 'worktree' ? 'lookout.reviewWorktree' : undefined;
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
  private readonly baselinesByWorktree = new Map<string, GitBaseline>();
  private readonly linkedBaselinesByWorktree = new Map<string, GitBaseline>();
  private reviewWorktrees: readonly WorktreeChanges[] = [];
  private changeCount = 0;
  private diagnostics: ReviewTreeItem[] = [];
  private runtime: ReviewTreeItem[] = [];
  private commandResults: ReviewTreeItem[] = [];
  private images: ReviewTreeItem[] = [];
  private plans: ReviewTreeItem[] = [];
  private planCount = 0;
  private readonly plansByWorktree = new Map<string, ReviewTreeItem[]>();
  private readonly diagnosticsSource = new VscodeDiagnosticEvidenceSource();
  private verification: VerificationManager | undefined;
  private readonly packetsByWorktree = new Map<
    string,
    ReviewPacket | 'unavailable'
  >();
  private planPaths = new Set<string>();
  private changeMessage = 'Select an agent with a Git baseline to review changes';
  // Beyond this, a tree stops being reviewable; Source Control owns the full
  // surface (D1). Keeps a stray node_modules/.venv from rendering thousands
  // of rows every refresh tick.
  private static readonly maxChangesPerWorktree = 100;
  private refreshGeneration = 0;
  private changeGeneration = 0;
  private evidenceGeneration = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private refreshTimer: NodeJS.Timeout | undefined;
  private worktreeRefreshTimer: NodeJS.Timeout | undefined;
  private initialized = false;
  private visible = true;
  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly onDidChange = this.contentChangedEmitter.event;

  public constructor(
    private readonly sessions: SessionManager,
    private readonly workspaceState?: vscode.Memento,
    private readonly reportError: ReviewErrorReporter = () => undefined
  ) {
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
        this.reconcileVerificationContexts();
        this.scheduleRefresh();
        this.refreshRuntime();
      }),
      sessions.onDidChangeTopology(() => {
        this.reconcileVerificationContexts();
        this.scheduleRefresh();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.invalidateEvidenceForUri(document.uri);
        if (this.visible) {
          this.runBackground('save-refresh', () => this.refreshChanges());
        }
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        for (const root of this.diagnosticsSource.noteChanges(event.uris)) {
          this.verification?.invalidateRoot(root);
        }
        if (this.visible) {
          this.refreshDiagnostics();
          this.runBackground('diagnostic-refresh', () => this.refreshChanges());
        }
      }),
      vscode.tasks.onDidStartTask(() => this.refreshRuntime()),
      vscode.tasks.onDidEndTask(() => this.refreshRuntime()),
      vscode.debug.onDidStartDebugSession(() => this.refreshRuntime()),
      vscode.debug.onDidTerminateDebugSession(() => this.refreshRuntime()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (this.visible && event.affectsConfiguration('lookout.review')) {
          this.runBackground('configuration-refresh', () => this.refresh());
        }
      })
    );
  }

  public async initialize(): Promise<void> {
    const initial = loadVerificationStore(
      this.workspaceState?.get(VERIFICATION_STORE_KEY)
    );
    this.verification = new VerificationManager({
      diagnostics: this.diagnosticsSource,
      initial: {
        contexts: [...initial.contexts],
        runs: [...initial.runs],
        diagnosticBaselines: [...initial.diagnosticBaselines]
      }
    });
    this.initialized = true;
    this.reconcileVerificationContexts();
    this.refreshRuntime();
    if (this.visible) {
      await this.refresh();
      this.startWorktreePolling();
    }
  }

  public setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    if (!this.initialized) {
      return;
    }
    if (visible) {
      this.startWorktreePolling();
      this.runBackground('visible-refresh', () => this.refresh());
    } else {
      this.stopWorktreePolling();
    }
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
    const max = boundedReviewItemLimit(
      config.get<number>('maxItemsPerGroup', 12)
    );
    const showImages = config.get<boolean>('showRecentImages', false);
    const imageGlobs = normalizeReviewGlobs(
      [config.get<unknown>('imageGlob', '**/*.{png,jpg,jpeg,gif,webp}')],
      ['**/*.{png,jpg,jpeg,gif,webp}']
    );
    const artifactGlobs = normalizeReviewGlobs(
      config.get<unknown[]>('artifactGlobs'),
      [
        '**/{plans,docs}/**/*.{md,mdx,txt}',
        '**/todos/**/*.{md,mdx,txt}',
        '**/{TODOS,DESIGN,TESTPLAN}.{md,mdx,txt}'
      ]
    );
    const searchLimit = reviewSearchResultLimit(max);
    const session = this.sessions.selectedSession;
    const worktreeChanges = await loadWorktreeChanges(
      this.sessions,
      this.linkedBaselinesByWorktree
    );
    if (generation !== this.refreshGeneration) {
      return;
    }
    this.reviewWorktrees = worktreeChanges;
    this.reconcileVerificationContexts();
    const [imageUris, planUris] = await Promise.all([
      showImages
        ? findFilesAcrossAgentRoots(
            this.sessions,
            worktreeChanges,
            imageGlobs,
            '**/{node_modules,.git,out,dist}/**',
            searchLimit
          )
        : Promise.resolve([]),
      findFilesAcrossAgentRoots(
        this.sessions,
        worktreeChanges,
        artifactGlobs,
        '**/{node_modules,.git,out,dist}/**',
        searchLimit
      )
    ]);
    const [images, planArtifacts] = await Promise.all([
      toArtifactItems('image', imageUris, max, session),
      toChangedPlanItems(planUris, worktreeChanges, max)
    ]);
    await this.refreshReviewEvidence();
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
    if (!this.visible) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.runBackground('scheduled-refresh', () => this.refresh());
    }, 250);
  }

  public async refreshChanges(): Promise<void> {
    const generation = ++this.changeGeneration;
    const worktreeChanges = await loadWorktreeChanges(
      this.sessions,
      this.linkedBaselinesByWorktree
    );
    if (generation !== this.changeGeneration) {
      return;
    }
    this.reviewWorktrees = worktreeChanges;
    this.reconcileVerificationContexts();
    await this.refreshReviewEvidence();
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
            ...(running.activityKind ? { activityKind: running.activityKind } : {}),
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

  /**
   * Runs one user-selected VS Code task and records only bounded verification
   * metadata against one physical-worktree review context.
   */
  public async runVerification(item?: ReviewTreeItem): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Trust this workspace before running verification tasks.'
      );
      return;
    }
    const verification = this.verification;
    if (!verification) {
      void vscode.window.showWarningMessage(
        'Review evidence is still initializing. Try again in a moment.'
      );
      return;
    }
    this.reconcileVerificationContexts();
    const context = await this.pickVerificationContext(item);
    if (!context) {
      return;
    }
    const selection = await pickVerificationTask();
    if (!selection) {
      return;
    }
    const identity = verificationTaskIdentity(selection.task, selection.kind);
    const policy = taskVerificationPolicy(identity);
    const running = startTaskVerificationRun(context.id, identity);
    verification.recordRun(running);
    this.persistVerificationSnapshot();
    this.runBackground('verification-start-refresh', () => this.refreshChanges());

    const completion = await observeTaskCompletion(selection.task);
    let signature: import('./verification/verificationTypes').VerificationFreshnessSignature | undefined;
    try {
      signature = (
        await verification.getReviewPacket(context.id, {
          policy,
          force: true
        })
      ).signature;
    } catch {
      // Without current bounded evidence, the run remains incomplete even if
      // the task process itself exited successfully.
    }
    const completed = completeTaskVerificationRun(
      running,
      completion,
      signature
    );
    verification.recordRun(completed);
    this.persistVerificationSnapshot();
    await this.refreshChanges();
    showVerificationOutcome(completed.checks[0].outcome);
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
    const query = new URLSearchParams(uri.query);
    const worktreeKey = query.get('worktree');
    const baseline = worktreeKey
      ? this.baselinesByWorktree.get(normalizeRootKey(worktreeKey))
      : session?.baseline;
    if (!session || !baseline) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (query.get('empty') === '1') {
      return '';
    }
    const baselinePath = query.get('baselinePath') ?? uri.path.slice(1);
    return readBaselineFile(baseline, baselinePath);
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.stopWorktreePolling();
    this.verification?.dispose();
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
    this.contentChangedEmitter.dispose();
  }

  private startWorktreePolling(): void {
    if (this.worktreeRefreshTimer) {
      return;
    }
    this.worktreeRefreshTimer = setInterval(
      () => this.runBackground('poll-refresh', () => this.refreshChanges()),
      10_000
    );
  }

  private stopWorktreePolling(): void {
    if (this.worktreeRefreshTimer) {
      clearInterval(this.worktreeRefreshTimer);
      this.worktreeRefreshTimer = undefined;
    }
  }

  private runBackground(scope: string, operation: () => Promise<void>): void {
    void operation().catch((error: unknown) => this.reportError(scope, error));
  }

  private reconcileVerificationContexts(): void {
    if (!this.verification) {
      return;
    }
    const direct = toReviewSessionSnapshots(
      this.sessions.history(),
      (sessionId) => this.sessions.isOpen(sessionId)
    );
    const linked = this.reviewWorktrees
      .filter((worktree) => worktree.linked)
      .flatMap((worktree) =>
        worktree.sessions.map((session) => ({
          id: session.id,
          isOpen: this.sessions.isOpen(session.id),
          baseline: {
            ...worktree.baseline,
            capturedAt: Math.max(
              worktree.baseline.capturedAt,
              session.createdAt
            )
          }
        }))
      );
    this.verification.reconcileSessions([...direct, ...linked]);
    this.persistVerificationSnapshot();
  }

  private async refreshReviewEvidence(): Promise<void> {
    const verification = this.verification;
    if (!verification) {
      return;
    }
    const generation = ++this.evidenceGeneration;
    const activeContexts = verification
      .listContexts()
      .filter((context) => context.status === 'active');
    const packets = await Promise.all(
      activeContexts.map(async (context) => {
        try {
          const latestRun = verification.latestRun(context.id);
          const policy = latestRun
            ? restoredTaskVerificationPolicy(latestRun)
            : undefined;
          return {
            key: normalizeRootKey(context.repoRoot),
            packet: await verification.getReviewPacket(context.id, { policy })
          } as const;
        } catch {
          return {
            key: normalizeRootKey(context.repoRoot),
            packet: 'unavailable' as const
          };
        }
      })
    );
    if (generation !== this.evidenceGeneration) {
      return;
    }
    this.packetsByWorktree.clear();
    for (const value of packets) {
      this.packetsByWorktree.set(value.key, value.packet);
    }
  }

  private async pickVerificationContext(
    item: ReviewTreeItem | undefined
  ): Promise<ReviewContext | undefined> {
    const active = (this.verification?.listContexts() ?? []).filter(
      (context) => context.status === 'active'
    );
    const requestedRoot = item?.worktreeKey
      ? normalizeRootKey(item.worktreeKey)
      : this.sessions.selectedSession?.baseline
        ? normalizeRootKey(this.sessions.selectedSession.baseline.repoRoot)
        : undefined;
    const requested = requestedRoot
      ? active.find((context) => normalizeRootKey(context.repoRoot) === requestedRoot)
      : undefined;
    if (requested) {
      return requested;
    }
    if (active.length === 0) {
      void vscode.window.showInformationMessage(
        'No active agent has a Git baseline for verification.'
      );
      return undefined;
    }
    if (active.length === 1) {
      return active[0];
    }
    return (
      await vscode.window.showQuickPick(
        active.map((context) => ({
          label: path.basename(context.repoRoot),
          description: context.repoRoot,
          context
        })),
        {
          title: 'Select Physical Worktree to Verify',
          placeHolder: 'Verification evidence is scoped to this worktree'
        }
      )
    )?.context;
  }

  private invalidateEvidenceForUri(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    for (const context of this.verification?.listContexts() ?? []) {
      if (context.status === 'active' && isWithin(context.repoRoot, uri.fsPath)) {
        this.verification?.invalidateContext(context.id);
      }
    }
  }

  private persistVerificationSnapshot(): void {
    if (!this.workspaceState || !this.verification) {
      return;
    }
    const snapshot = this.verification.snapshot();
    const value = persistableVerificationStore({
      version: VERIFICATION_STORE_VERSION,
      contexts: snapshot.contexts,
      runs: snapshot.runs,
      diagnosticBaselines: snapshot.diagnosticBaselines
    });
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.workspaceState!.update(VERIFICATION_STORE_KEY, value));
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
      const baseline = worktree.baseline;
      this.baselinesByWorktree.set(normalizeRootKey(worktree.key), baseline);
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
                    worktreeKey: worktree.key,
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
      const packet = this.packetsByWorktree.get(
        normalizeRootKey(baseline.repoRoot)
      );
      const evidenceItems = reviewPacketItems(packet);
      const childItems = [
        ...(branchChanged
          ? [
            new ReviewTreeItem(
              'message',
              worktree.linked
                ? 'Branch changed since worktree discovery'
                : 'Branch changed since agent launch',
              {
                description: `${branchLabel(baseline.branch, baseline.commit)} → ${branchLabel(
                  worktree.state.branch,
                  worktree.state.commit
                )} · captured baseline is stale`
              }
            )
          ]
          : []),
        ...evidenceItems,
        ...changeItems
      ];
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
            }${worktree.linked ? ' · delegated worktree' : ''} · ${
              changes?.length ?? 0
            } changes${packetDescription(packet)}`,
            warning: branchChanged || packetWarning(packet),
            tooltip: [
              baseline.repoRoot,
              `Agents: ${worktree.agentDetails.join(', ')}`,
              worktree.linked
                ? 'Discovered as a linked worktree created while an attached agent was open. Provider hooks do not identify which delegated agent owns it; attribution remains worktree-level.'
                : 'Direct Lookout session worktree.',
              `${worktree.linked ? 'Review' : 'Launch'} baseline: ${baseline.branch} @ ${baseline.commit}`,
              `Current branch: ${worktree.state.branch} @ ${worktree.state.commit}`,
              ...(branchChanged
                ? ['Warning: branch changed; the captured diff baseline is stale.']
                : []),
              ...packetTooltip(packet)
            ].join('\n')
          }
        )
      );
    }
  }

  private async openChange(item: ReviewTreeItem): Promise<void> {
    const session = item.sessionId ? this.sessions.get(item.sessionId) : undefined;
    const change = item.change;
    const baseline = item.worktreeKey
      ? this.baselinesByWorktree.get(normalizeRootKey(item.worktreeKey))
      : session?.baseline;
    if (!session || !baseline || !change || !item.uri) {
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
    const worktreeQuery = item.worktreeKey
      ? `worktree=${encodeURIComponent(item.worktreeKey)}`
      : '';
    const baselinePathQuery = change.previousPath
      ? `baselinePath=${encodeURIComponent(change.previousPath)}`
      : '';
    const baselineUri = vscode.Uri.from({
      scheme: BASELINE_SCHEME,
      authority: session.id,
      path: `/${change.path}`,
      query: hasBaseline
        ? [worktreeQuery, baselinePathQuery].filter(Boolean).join('&')
        : [worktreeQuery, 'empty=1'].filter(Boolean).join('&')
    });
    if (change.kind === 'deleted') {
      const emptyWorkingUri = vscode.Uri.from({
        scheme: BASELINE_SCHEME,
        authority: session.id,
        path: `/${change.path}`,
        query: [worktreeQuery, 'empty=1', 'side=working']
          .filter(Boolean)
          .join('&')
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

interface SelectedVerificationTask {
  readonly task: vscode.Task;
  readonly kind: VerificationTaskKind;
}

async function pickVerificationTask(): Promise<SelectedVerificationTask | undefined> {
  const allTasks = await vscode.tasks.fetchTasks();
  const testTasks = allTasks.filter((task) => task.group === vscode.TaskGroup.Test);
  let kind: VerificationTaskKind = 'test';
  let candidates = testTasks;
  if (testTasks.length === 0) {
    if (allTasks.length === 0) {
      void vscode.window.showInformationMessage(
        'No VS Code workspace tasks are available. No verification was recorded.'
      );
      return undefined;
    }
    const choice = await vscode.window.showInformationMessage(
      'No tasks declared in the VS Code Test group were found. A workspace task fallback is not assumed to be a test.',
      'Choose Workspace Task Fallback'
    );
    if (choice !== 'Choose Workspace Task Fallback') {
      return undefined;
    }
    kind = 'workspace-fallback';
    candidates = allTasks;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((task) => ({
      label: task.name,
      description: task.source,
      detail:
        kind === 'test'
          ? 'VS Code Test task'
          : 'Workspace task fallback — not declared as a Test task',
      task
    })),
    {
      title:
        kind === 'test'
          ? 'Run Verification · VS Code Test Task'
          : 'Run Verification · Workspace Task Fallback',
      placeHolder: 'Cancel records no verification result'
    }
  );
  return picked ? { task: picked.task, kind } : undefined;
}

function verificationTaskIdentity(
  task: vscode.Task,
  kind: VerificationTaskKind
): VerificationTaskIdentity {
  const scope = task.scope;
  const scopeIdentity = typeof scope === 'object'
    ? normalizeRootKey(scope.uri.fsPath)
    : scope === vscode.TaskScope.Global
      ? 'global'
      : 'workspace';
  return {
    kind,
    name: task.name,
    source: task.source,
    definitionType:
      typeof task.definition.type === 'string'
        ? task.definition.type
        : 'unknown',
    scope: scopeIdentity
  };
}

async function observeTaskCompletion(task: vscode.Task): Promise<TaskCompletion> {
  return new Promise((resolve) => {
    let execution: vscode.TaskExecution | undefined;
    let observedExecution: vscode.TaskExecution | undefined;
    let exitCode: number | undefined;
    let settled = false;
    const matches = (candidate: vscode.TaskExecution): boolean => {
      if (execution) {
        return candidate === execution;
      }
      if (observedExecution) {
        return candidate === observedExecution;
      }
      if (candidate.task === task) {
        observedExecution = candidate;
        return true;
      }
      return false;
    };
    const finish = (completion: TaskCompletion): void => {
      if (settled) {
        return;
      }
      settled = true;
      processEnded.dispose();
      taskEnded.dispose();
      resolve(completion);
    };
    const processEnded = vscode.tasks.onDidEndTaskProcess((event) => {
      if (matches(event.execution)) {
        exitCode = event.exitCode;
      }
    });
    const taskEnded = vscode.tasks.onDidEndTask((event) => {
      if (matches(event.execution)) {
        finish(exitCode === undefined ? {} : { exitCode });
      }
    });
    void vscode.tasks.executeTask(task).then(
      (started) => {
        execution = started;
        if (observedExecution && observedExecution !== started) {
          finish({ launchFailed: true });
        }
      },
      () => finish({ launchFailed: true })
    );
  });
}

function showVerificationOutcome(
  outcome: import('./verification/verificationTypes').VerificationCheckOutcome
): void {
  switch (outcome) {
    case 'passed':
      void vscode.window.showInformationMessage(
        'Verification task passed. Review readiness was refreshed.'
      );
      return;
    case 'failed':
      void vscode.window.showErrorMessage(
        'Verification task failed. Open the task terminal for details.'
      );
      return;
    default:
      void vscode.window.showWarningMessage(
        'Verification task ended without a known process exit. No success was recorded.'
      );
  }
}

async function loadWorktreeChanges(
  sessions: SessionManager,
  linkedBaselines: Map<string, GitBaseline>
): Promise<WorktreeChanges[]> {
  const sessionsByWorktree = new Map<string, AgentSession[]>();
  for (const session of sessions.history()) {
    if (!session.baseline) {
      continue;
    }
    const key = normalizeRootKey(session.baseline.repoRoot);
    const existing = sessionsByWorktree.get(key) ?? [];
    existing.push(session);
    sessionsByWorktree.set(key, existing);
  }

  const direct = [...sessionsByWorktree.entries()].filter(
    ([, attachedSessions]) =>
      attachedSessions.some((session) => sessions.isOpen(session.id))
  );
  const linked = new Map<
    string,
    {
      readonly repoRoot: string;
      readonly commit: string;
      readonly branch: string;
      readonly createdAt: number;
      readonly sessions: Map<string, AgentSession>;
    }
  >();
  await Promise.all(
    direct.map(async ([sourceKey, attachedSessions]) => {
      const openSessions = attachedSessions.filter((session) =>
        sessions.isOpen(session.id)
      );
      let registrations: Awaited<ReturnType<typeof listGitWorktrees>>;
      try {
        registrations = await listGitWorktrees(sourceKey);
      } catch {
        return;
      }
      await Promise.all(
        registrations.slice(0, MAX_REVIEW_ROOTS).map(async (registration) => {
          const key = normalizeRootKey(registration.repoRoot);
          if (sessionsByWorktree.has(key)) {
            return;
          }
          let createdAt: number;
          try {
            createdAt = (
              await vscode.workspace.fs.stat(
                vscode.Uri.file(path.join(registration.repoRoot, '.git'))
              )
            ).mtime;
          } catch {
            return;
          }
          // Worktree metadata is created with the worktree. Limiting discovery
          // to registrations newer than an open session avoids presenting old,
          // unrelated developer worktrees as delegated-agent output.
          const owners = openSessions.filter(
            (session) => createdAt >= session.createdAt - 2_000
          );
          if (owners.length === 0) {
            return;
          }
          const existing = linked.get(key) ?? {
            ...registration,
            createdAt,
            sessions: new Map<string, AgentSession>()
          };
          for (const session of owners) {
            existing.sessions.set(session.id, session);
          }
          linked.set(key, existing);
        })
      );
    })
  );

  const directWorktrees = direct.map(
    ([key, attachedSessions]) => ({
      key,
      sessions: attachedSessions,
      linked: false as const
    })
  );
  const linkedWorktrees = [...linked.entries()].map(([key, registration]) => ({
    key,
    sessions: [...registration.sessions.values()],
    linked: true as const,
    registration
  }));

  return Promise.all(
    [...directWorktrees, ...linkedWorktrees.slice(0, MAX_REVIEW_ROOTS)].map(
      async (entry) => {
        const { key, sessions: attachedSessions } = entry;
        const sorted = attachedSessions.sort(
          (left, right) => left.createdAt - right.createdAt
        );
        // One physical worktree has one review context. Keep the earliest valid
        // launch baseline stable while more sessions attach; switching to the
        // newest session would make already-reviewed changes disappear.
        const session = sorted[0];
        const linkedRegistration = 'registration' in entry
          ? entry.registration
          : undefined;
        const linkedBaselineKey = `${normalizeRootKey(key)}\0${session.id}`;
        const cachedLinkedBaseline = linkedRegistration
          ? linkedBaselines.get(linkedBaselineKey)
          : undefined;
        const baseline = linkedRegistration
          ? cachedLinkedBaseline?.capturedAt === linkedRegistration.createdAt
            ? cachedLinkedBaseline
            : {
                repoRoot: linkedRegistration.repoRoot,
                commit: session.baseline!.commit,
                branch: linkedRegistration.branch,
                capturedAt: linkedRegistration.createdAt
              }
          : session.baseline!;
        if (linkedRegistration) {
          linkedBaselines.set(linkedBaselineKey, baseline);
        }
        let changes: WorkspaceChange[] | undefined;
        let state: GitWorktreeState = {
          repoRoot: baseline.repoRoot,
          repositoryName: path.basename(session.baseline!.repoRoot),
          commit: linkedRegistration?.commit ?? baseline.commit,
          branch: linkedRegistration?.branch ?? baseline.branch
        };
        try {
          changes = await listWorkspaceChanges(baseline);
        } catch {
          changes = undefined;
        }
        try {
          state = await readGitWorktreeState(baseline.repoRoot);
        } catch {
          // Keep the launch baseline as an honest fallback while retaining changes.
        }
        return {
          key,
          session,
          sessions: sorted,
          baseline,
          linked: entry.linked,
          startedAt: linkedRegistration?.createdAt ?? sorted[0].createdAt,
          agentLabels: sorted.map((attached) => attached.label),
          agentDetails: sorted.map(
            (attached) => `${attached.label} (${attached.kind})`
          ),
          changes,
          state
        };
      }
    )
  );
}

async function findFilesAcrossAgentRoots(
  sessions: SessionManager,
  worktrees: readonly WorktreeChanges[],
  includes: readonly string[],
  exclude: string,
  maxResultsPerRoot?: number
): Promise<vscode.Uri[]> {
  const roots = new Map<string, vscode.Uri>();
  for (const session of sessions.list()) {
    const root = session.baseline?.repoRoot ?? session.cwd;
    const resolved = path.resolve(root);
    roots.set(normalizeRootKey(resolved), vscode.Uri.file(resolved));
  }
  for (const worktree of worktrees) {
    const resolved = path.resolve(worktree.state.repoRoot);
    roots.set(normalizeRootKey(resolved), vscode.Uri.file(resolved));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const key = normalizeRootKey(folder.uri.fsPath);
    if (!roots.has(key)) {
      roots.set(key, folder.uri);
    }
  }

  const perPatternLimit = maxResultsPerRoot === undefined
    ? undefined
    : Math.max(1, Math.ceil(maxResultsPerRoot / Math.max(1, includes.length)));
  const matches = await Promise.all(
    [...roots.values()].slice(0, MAX_REVIEW_ROOTS).flatMap((root) => includes.map(async (include) => {
      try {
        return await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, include),
          exclude,
          perPatternLimit
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

function reviewPacketItems(
  packet: ReviewPacket | 'unavailable' | undefined
): ReviewTreeItem[] {
  if (!packet) {
    return [
      new ReviewTreeItem('evidence', 'Collecting review evidence…', {
        description: 'Git and diagnostic evidence are loading'
      })
    ];
  }
  if (packet === 'unavailable') {
    return [
      new ReviewTreeItem('evidence', 'Review evidence unavailable', {
        description: 'Collection failed; no readiness claim can be made',
        tooltip:
          'Lookout could not collect the bounded Git and diagnostic review packet.',
        warning: true
      })
    ];
  }
  const diff = packet.git.diff;
  return [
    new ReviewTreeItem('evidence', 'Diff evidence', {
      description: `${diff.files} files · +${diff.additions} −${diff.deletions} · ${diff.untrackedFiles} untracked`,
      tooltip: [
        `Baseline: ${packet.git.baseline.branch} @ ${packet.git.baseline.commit}`,
        `Current: ${packet.git.branch} @ ${packet.git.commit}`,
        `${diff.binaryFiles} binary files`,
        diff.truncated ? 'File details are bounded and truncated.' : ''
      ]
        .filter(Boolean)
        .join('\n'),
      warning: packet.git.state !== 'complete' || packet.git.baseline.stale
    })
  ];
}

function packetDescription(
  packet: ReviewPacket | 'unavailable' | undefined
): string {
  if (!packet) {
    return ' · evidence loading';
  }
  return packet === 'unavailable'
    ? ' · evidence unavailable'
    : ` · verification ${packet.readiness.state}`;
}

function packetWarning(
  packet: ReviewPacket | 'unavailable' | undefined
): boolean {
  if (!packet) {
    return false;
  }
  return packet === 'unavailable' || packet.readiness.state === 'failed';
}

function packetTooltip(
  packet: ReviewPacket | 'unavailable' | undefined
): string[] {
  if (!packet) {
    return ['Review evidence is still loading.'];
  }
  if (packet === 'unavailable') {
    return ['Review evidence collection failed; readiness is unknown.'];
  }
  return [
    `Verification: ${packet.readiness.state}`,
    `Evidence: Git ${packet.git.state}, diagnostics ${packet.diagnostics.state}`,
    `Attribution: ${packet.attribution}`
  ];
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
          return stat.mtime >= worktree.startedAt
            ? { change, uri, stat }
            : undefined;
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
          description: `${worktree.state.branch}${
            worktree.linked ? ' · delegated worktree' : ''
          } · ${items.length} artifacts`,
          tooltip: `${worktree.state.repoRoot}\nAgents: ${worktree.agentDetails.join(', ')}${
            worktree.linked
              ? '\nLinked worktree discovered while the attached agent was open; delegated-agent ownership is unavailable.'
              : ''
          }`
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

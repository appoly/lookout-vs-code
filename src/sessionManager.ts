import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AttentionServer,
  type AttentionEndpoint
} from './attentionServer';
import { AttentionSound } from './attentionSound';
import {
  classifyShell,
  hookRunnerShell,
  isDirectAgentCommand,
  PROVIDER_ACTIVITY_TOOL_MATCHER,
  shellQuote,
  withCodexLifecycleIntegration,
  withCodexTokenBudget,
  type LaunchShell
} from './agentCommand';
import { captureGitBaseline, listUncommittedChanges } from './gitReview';
import { inferSessionLabel } from './sessionNaming';
import {
  createSession,
  isActiveSession,
  markSessionRead,
  transitionSession
} from './sessionModel';
import { latestDelegatedTokenUsage } from './sessionTokenUsage';
import {
  applyAgentEvent,
  normalizeSessionActivity
} from './sessionActivity';
import {
  appendSessionEvent,
  eventFromAgentEvent,
  markSessionEventsRead,
  removeSessionEvents,
  type EventLedger,
  type SessionEvent,
  type SessionEventKind,
  type SessionEventSource
} from './sessionEvents';
import { SessionStore } from './sessionStore';
import {
  bindProviderSession,
  providerSessionCollision
} from './providerSessionBinding';
import { providerFor } from './providers/providerRegistry';
import { matchRestoredTerminals } from './restoreTerminalMatcher';
import type {
  AgentEvent,
  AgentReportedStatus,
  AgentSession,
  CommandResult,
  DelegatedAgentTokenUsage,
  LaunchRequest,
  ManagedAgentKind
} from './types';
import type { UsageBridgeEvent } from './usageTypes';

const BRIDGE_STORAGE_KEY = 'lookout.attentionEndpoint.v1';
const CODEX_HOOK_NOTICE_KEY = 'lookout.codexHookNotice.v1';
const MAX_COMMAND_RESULTS_PER_SESSION = 12;

export interface ProviderContinuationSource {
  readonly kind: ManagedAgentKind;
  readonly label: string;
  readonly cwd: string;
  readonly configuredCommand: string;
  readonly sourceLookoutSessionId: string;
  readonly providerSessionId: string;
}

export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly commandResults = new Map<string, CommandResult[]>();
  private readonly pendingDelegatedUsage = new Map<
    string,
    {
      readonly observedAt: number;
      readonly delegatedAgents: readonly DelegatedAgentTokenUsage[];
    }
  >();
  private readonly delegatedUsageObservedAt = new Map<string, number>();
  private commandResultSequence = 0;
  private eventLedger: EventLedger = { nextSequence: 1, events: [] };
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly agentExecutions = new Map<
    string,
    vscode.TerminalShellExecution
  >();
  private readonly agentLaunchesInFlight = new Set<string>();
  private readonly untrackedAgentCommands = new Set<string>();
  private readonly restartsInFlight = new Set<string>();
  private readonly sessionIdsByTerminal = new Map<vscode.Terminal, string>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly topologyEmitter = new vscode.EventEmitter<void>();
  private readonly selectedEmitter = new vscode.EventEmitter<AgentSession | undefined>();
  private readonly usageEmitter = new vscode.EventEmitter<UsageBridgeEvent>();
  private readonly attentionServer = new AttentionServer((event) => {
    void this.handleAgentEvent(event);
  }, (event) => {
    this.handleUsageEvent(event);
    this.usageEmitter.fire(event);
  });
  private readonly disposables: vscode.Disposable[] = [];
  private selectedSessionId: string | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private attentionEndpoint: AttentionEndpoint | undefined;
  private bridgeWarningShown = false;
  private readonly attentionSound: AttentionSound;
  private readonly sessionStore: SessionStore;

  public readonly onDidChange = this.changedEmitter.event;
  public readonly onDidChangeTopology = this.topologyEmitter.event;
  public readonly onDidSelectSession = this.selectedEmitter.event;
  public readonly onDidReceiveUsage = this.usageEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.attentionSound = new AttentionSound(context);
    this.sessionStore = new SessionStore(context.workspaceState);
  }

  public async initialize(): Promise<void> {
    const preferredEndpoint = this.context.workspaceState.get<AttentionEndpoint>(
      BRIDGE_STORAGE_KEY
    );
    let bridgeReused = false;
    try {
      this.attentionEndpoint = await this.attentionServer.start(preferredEndpoint);
      bridgeReused = sameEndpoint(preferredEndpoint, this.attentionEndpoint);
      await this.context.workspaceState.update(
        BRIDGE_STORAGE_KEY,
        this.attentionEndpoint
      );
    } catch {
      this.attentionEndpoint = undefined;
    }
    const persisted = await this.sessionStore.load();
    const stored = persisted.sessions;
    this.eventLedger = {
      nextSequence: persisted.nextSequence,
      events: persisted.events
    };
    const restoredTerminals = matchRestoredTerminals(
      stored.map((session) => ({
        id: session.id,
        terminalName: session.terminalName
      })),
      vscode.window.terminals.map((terminal) => {
        const sessionId = sessionIdFromTerminal(terminal);
        return {
          value: terminal,
          name: terminal.name,
          ...(sessionId ? { sessionId } : {})
        };
      })
    );

    for (const saved of stored) {
      const normalizedSaved = normalizeSessionActivity(saved);
      const terminal = restoredTerminals.get(saved.id);
      // Without a reusable bridge no event can ever arrive, so transient
      // statuses would otherwise be stuck (a permanent false "waiting for
      // you"). A live process is only ever claimed as active.
      const demoteStale =
        !bridgeReused &&
        ['starting', 'running', 'background', 'attention'].includes(
          normalizedSaved.status
        );
      const session: AgentSession = terminal
        ? {
            ...(demoteStale
              ? transitionSession(normalizedSaved, 'active', Date.now())
              : normalizedSaved),
            unread: demoteStale ? false : normalizedSaved.unread,
            bridgeAvailable:
              bridgeReused && normalizedSaved.bridgeAvailable === true,
            integration: !bridgeReused
              ? {
                  ...normalizedSaved.integration,
                  lifecycle: 'bridge-unavailable'
                }
              : normalizedSaved.integration,
            ...(!bridgeReused
              ? {
                  backgroundAgents: [],
                  runningCommands: [],
                  foregroundState: 'unknown',
                  latestEvent: 'Restored terminal · hooks require a new session'
                }
              : {})
          }
        : {
            ...transitionSession(
              normalizedSaved,
              'closed',
              Date.now(),
              saved.exitCode,
              'Terminal is no longer open'
            ),
            bridgeAvailable: false,
            backgroundAgents: [],
            runningCommands: [],
            foregroundState: 'stopped'
          };
      this.sessions.set(session.id, session);
      if (terminal) {
        this.attachTerminal(session.id, terminal);
        if (session.command) {
          // Shell execution handles do not survive extension-host reloads, so
          // the process state cannot be proven safe for in-place restart.
          this.untrackedAgentCommands.add(session.id);
        }
      }
    }
    this.selectedSessionId =
      stored.find(
        (session) => !session.archivedAt && this.terminals.has(session.id)
      )?.id ?? stored.find((session) => !session.archivedAt)?.id;

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const id = this.sessionIdsByTerminal.get(event.terminal);
        if (id && this.agentExecutions.get(id) === event.execution) {
          this.recordEvent(
            id,
            'terminal-active',
            'terminal',
            'Agent terminal command started'
          );
          this.updateSession(id, 'active', undefined, 'Agent session active');
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const id = this.sessionIdsByTerminal.get(event.terminal);
        if (!id || this.agentExecutions.get(id) !== event.execution) {
          return;
        }
        this.agentExecutions.delete(id);
        const exitCode = event.exitCode;
        const failed = exitCode !== undefined && exitCode !== 0;
        const status: AgentSession['status'] =
          exitCode === undefined ? 'unknown' : failed ? 'failed' : 'completed';
        const notificationOutcome =
          exitCode === undefined
            ? 'agent command ended with unknown status'
            : failed
              ? 'agent failed'
              : 'agent finished';
        this.recordEvent(
          id,
          'terminal-exited',
          'terminal',
          exitCode === undefined
            ? 'Agent terminal command ended with unknown status'
            : failed
              ? 'Agent terminal command failed'
              : 'Agent terminal command completed',
          'notice'
        );
        this.updateSession(
          id,
          status,
          exitCode,
          exitCode === undefined
            ? 'Agent command ended without an exit code'
            : failed
              ? `Agent exited with code ${exitCode}`
              : 'Agent command finished'
        );
        if (
          vscode.workspace.getConfiguration('lookout').get('notifyOnAgentExit', true) &&
          (!vscode.window.state.focused ||
            vscode.window.activeTerminal !== event.terminal)
        ) {
          void this.attentionSound.play();
          const session = this.sessions.get(id);
          if (session) {
            void vscode.window.showInformationMessage(
              `${session.label}: ${notificationOutcome}`,
              'Focus Agent'
            ).then((choice) => {
              if (choice) {
                void this.focus(id);
              }
            });
          }
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const id = this.sessionIdsByTerminal.get(terminal);
        if (!id) {
          return;
        }
        this.terminals.delete(id);
        this.agentExecutions.delete(id);
        this.agentLaunchesInFlight.delete(id);
        this.untrackedAgentCommands.delete(id);
        this.restartsInFlight.delete(id);
        this.commandResults.delete(id);
        this.pendingDelegatedUsage.delete(id);
        this.delegatedUsageObservedAt.delete(id);
        this.sessionIdsByTerminal.delete(terminal);
        void this.deleteClaudeSettings(id);
        this.topologyEmitter.fire();
        this.recordEvent(
          id,
          'terminal-closed',
          'terminal',
          'Agent terminal closed',
          'notice'
        );
        this.updateSession(id, 'closed', terminal.exitStatus?.code, 'Terminal closed');
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) {
          return;
        }
        const id = this.sessionIdsByTerminal.get(terminal);
        if (id) {
          this.markRead(id);
          this.selectSession(id);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('lookout.review.captureCommandOutput') &&
          !this.captureCommandOutputEnabled()
        ) {
          this.commandResults.clear();
          this.changedEmitter.fire();
        }
      })
    );
    this.changedEmitter.fire();
  }

  public list(): readonly AgentSession[] {
    // Sort by createdAt (immutable) so sessions keep a stable position.
    // Sorting by updatedAt made agents jump around the list every time they
    // emitted an event.
    return this.history().filter((session) => session.archivedAt === undefined);
  }

  public history(): readonly AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  public get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  public commandResultsFor(id: string): readonly CommandResult[] {
    return this.commandResults.get(id) ?? [];
  }

  public eventsFor(id?: string): readonly SessionEvent[] {
    return id
      ? this.eventLedger.events.filter((event) => event.sessionId === id)
      : this.eventLedger.events;
  }

  public get activeCount(): number {
    return this.list().filter(isActiveSession).length;
  }

  public isOpen(id: string): boolean {
    return this.terminals.has(id);
  }

  public managesTerminal(terminal: vscode.Terminal): boolean {
    return this.sessionIdsByTerminal.has(terminal);
  }

  public get selectedSession(): AgentSession | undefined {
    return this.selectedSessionId
      ? this.sessions.get(this.selectedSessionId)
      : undefined;
  }

  public async launch(request: LaunchRequest): Promise<AgentSession> {
    const baseline = await captureGitBaseline(request.cwd);
    const label =
      request.label?.trim() ||
      inferSessionLabel({
        kind: request.kind,
        cwd: request.cwd,
        ...(baseline?.branch ? { branch: baseline.branch } : {}),
        existingLabels: [...this.sessions.values()].map(
          (session) => session.label
        )
      });
    const created = createSession(
      request.kind,
      label,
      request.command,
      request.cwd
    );
    const tokenBudget = configuredTokenBudget(request.kind, request.command);
    const session: AgentSession = {
      ...created,
      bridgeAvailable: this.attentionEndpoint !== undefined,
      ...(request.providerCommand
        ? { providerCommand: request.providerCommand }
        : {}),
      ...(request.lineage ? { lineage: request.lineage } : {}),
      ...(request.expectedProviderSessionId
        ? {
            integration: {
              ...created.integration,
              expectedProviderSessionId: request.expectedProviderSessionId
            }
          }
        : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(baseline ? { baseline } : {})
    };
    const parentTerminal = request.parentSessionId
      ? this.terminals.get(request.parentSessionId)
      : undefined;
    const configuredLocation = vscode.workspace
      .getConfiguration('lookout')
      .get<'editor' | 'panel'>('terminals.location', 'panel');
    const endpoint = this.attentionEndpoint;
    const location: vscode.TerminalOptions['location'] = parentTerminal
      ? { parentTerminal }
      : configuredLocation === 'editor'
        ? { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }
        : vscode.TerminalLocation.Panel;

    if (parentTerminal) {
      parentTerminal.show(false);
    }

    const launched = await this.prepareLaunchCommand(
      request,
      session.id,
      classifyShell(vscode.env.shell),
      session.tokenBudget
    );
    const lifecycleEnabled =
      request.kind === 'codex' || request.kind === 'claude'
        ? vscode.workspace
            .getConfiguration(`lookout.${request.kind}`)
            .get('lifecycleIntegration', true)
        : false;
    session.integration =
      request.kind === 'custom'
        ? { lifecycle: 'disabled', hookTrust: 'not-applicable' }
        : !lifecycleEnabled
          ? { lifecycle: 'disabled', hookTrust: 'not-applicable' }
        : !endpoint
          ? { lifecycle: 'bridge-unavailable', hookTrust: 'unknown' }
          : launched.integrationsSkipped
            ? { lifecycle: 'injection-skipped', hookTrust: 'unknown' }
            : session.integration;
    const terminal = vscode.window.createTerminal({
      name: session.terminalName,
      cwd: vscode.Uri.file(request.cwd),
      location,
      iconPath: new vscode.ThemeIcon(request.kind === 'claude' ? 'sparkle' : 'terminal'),
      env: {
        LOOKOUT_SESSION_ID: session.id,
        ...(endpoint
          ? {
              LOOKOUT_NOTIFY_URL: endpoint.url,
              LOOKOUT_NOTIFY_TOKEN: endpoint.token,
              LOOKOUT_NOTIFY_HELPER: path.join(
                this.context.extensionPath,
                'out',
                'src',
                'notify.js'
              ),
              LOOKOUT_USAGE_URL: endpoint.url.replace(/\/events$/, '/usage')
            }
          : {}),
        ...(endpoint &&
        this.captureCommandOutputEnabled() &&
        (request.kind === 'codex' || request.kind === 'claude')
          ? { LOOKOUT_CAPTURE_COMMAND_OUTPUT: '1' }
          : {})
      }
    });
    this.sessions.set(session.id, session);
    this.recordEvent(
      session.id,
      'session-created',
      'user',
      'Agent session created'
    );
    this.attachTerminal(session.id, terminal);
    this.topologyEmitter.fire();
    this.selectSession(session.id);
    await this.persistAndNotify();
    terminal.show(false);
    await this.executeAgentCommand(
      session.id,
      terminal,
      launched.command,
      launched.integrationsSkipped
        ? 'Agent session active · hooks unavailable in this terminal shell'
        : undefined
    );
    if (
      request.kind === 'codex' &&
      launched.command.includes('hooks.SubagentStart=')
    ) {
      void this.showCodexHookNotice(session.id);
    }
    if (!endpoint && !this.bridgeWarningShown) {
      this.bridgeWarningShown = true;
      void vscode.window.showWarningMessage(
        'Lookout could not start its local attention bridge. Terminals still work, but agent hooks and Claude usage updates are unavailable.'
      );
    }
    return session;
  }

  public async adopt(
    terminal: vscode.Terminal,
    kind: AgentSession['kind'],
    label: string,
    cwd: string
  ): Promise<AgentSession> {
    const baseline = await captureGitBaseline(cwd);
    const created = createSession(kind, label, '', cwd);
    const session: AgentSession = {
      ...created,
      status: 'active',
      bridgeAvailable: false,
      integration: { lifecycle: 'disabled', hookTrust: 'not-applicable' },
      // Keep the real terminal name: adopted terminals carry no session-ID
      // environment marker, so the name is the only way to re-attach them
      // after a window reload.
      terminalName: terminal.name,
      latestEvent: 'Adopted terminal · lifecycle hooks unavailable',
      ...(baseline ? { baseline } : {})
    };
    this.sessions.set(session.id, session);
    this.recordEvent(
      session.id,
      'session-adopted',
      'user',
      'Terminal adopted as an agent session'
    );
    this.attachTerminal(session.id, terminal);
    this.topologyEmitter.fire();
    this.selectSession(session.id);
    await this.persistAndNotify();
    return session;
  }

  public async focus(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      void vscode.window.showWarningMessage('That agent terminal is no longer open.');
      return;
    }
    this.markRead(id);
    this.selectSession(id);
    terminal.show(false);
  }

  public stageText(id: string, value: string): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal || !value.trim()) {
      return false;
    }
    terminal.show(false);
    terminal.sendText(value, false);
    return true;
  }

  public async continueProviderSession(
    id: string,
    operation: 'resume' | 'fork'
  ): Promise<AgentSession | undefined> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Trust this workspace before resuming or forking an agent session.'
      );
      return undefined;
    }
    const source = this.sessions.get(id);
    const reference = source?.providerSessions.at(-1);
    if (!source || !reference || source.kind === 'custom') {
      void vscode.window.showWarningMessage(
        'This agent has no provider session identity that Lookout can continue.'
      );
      return undefined;
    }

    return this.continueProviderReference({
      kind: source.kind,
      label: source.label,
      cwd: source.cwd,
      configuredCommand: source.providerCommand ?? source.command,
      sourceLookoutSessionId: source.id,
      providerSessionId: reference.id
    }, operation);
  }

  public async continueProviderReference(
    source: ProviderContinuationSource,
    operation: 'resume' | 'fork',
    options: { readonly confirm?: boolean } = {}
  ): Promise<AgentSession | undefined> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'Trust this workspace before resuming or forking an agent session.'
      );
      return undefined;
    }
    try {
      const directory = await vscode.workspace.fs.stat(vscode.Uri.file(source.cwd));
      if ((directory.type & vscode.FileType.Directory) === 0) {
        throw new Error('Not a directory');
      }
    } catch {
      void vscode.window.showWarningMessage(
        `The recorded working directory is unavailable on this execution host: ${source.cwd}`
      );
      return undefined;
    }

    const collision = providerSessionCollision(
      this.history(),
      '__new-session__',
      source.kind,
      source.providerSessionId,
      (sessionId) => this.isOpen(sessionId)
    );
    if (operation === 'resume' && collision) {
      const choice = await vscode.window.showWarningMessage(
        `${collision.label} already has this provider session open. Resume would attach two terminals to one provider history.`,
        { modal: true },
        'Focus Existing',
        'Fork Instead'
      );
      if (choice === 'Focus Existing') {
        await this.focus(collision.id);
        return undefined;
      }
      if (choice === 'Fork Instead') {
        return this.continueProviderReference(source, 'fork', options);
      }
      return undefined;
    }

    const adapter = providerFor(source.kind);
    const continuation =
      operation === 'resume'
        ? adapter.buildResume({
            configuredCommand: source.configuredCommand,
            providerSessionId: source.providerSessionId,
            shell: classifyShell(vscode.env.shell)
          })
        : adapter.buildFork({
            configuredCommand: source.configuredCommand,
            providerSessionId: source.providerSessionId,
            shell: classifyShell(vscode.env.shell)
          });
    if (!continuation.available || !continuation.command) {
      void vscode.window.showWarningMessage(
        continuation.reason ?? `${adapter.displayName} continuation is unavailable.`
      );
      return undefined;
    }
    if (options.confirm !== false) {
      const choice = await vscode.window.showInformationMessage(
        `${operation === 'resume' ? 'Resume' : 'Fork'} ${source.label} with ${adapter.displayName} in ${source.cwd}?\n\n${continuation.command}`,
        { modal: true },
        operation === 'resume' ? 'Resume Agent' : 'Fork Agent'
      );
      if (!choice) {
        return undefined;
      }
    }
    return this.launch({
      kind: source.kind,
      label: `${source.label} ${operation === 'resume' ? 'resumed' : 'fork'}`,
      command: continuation.command,
      providerCommand: source.configuredCommand,
      cwd: source.cwd,
      lineage: {
        operation,
        sourceLookoutSessionId: source.sourceLookoutSessionId,
        sourceProviderSessionId: source.providerSessionId
      },
      ...(operation === 'resume'
        ? { expectedProviderSessionId: source.providerSessionId }
        : {})
    });
  }

  public async archiveSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.archivedAt !== undefined) {
      return;
    }
    if (this.isOpen(id)) {
      void vscode.window.showWarningMessage(
        'Close the agent terminal before archiving its Lookout history.'
      );
      return;
    }
    session.archivedAt = Date.now();
    session.updatedAt = session.archivedAt;
    if (this.selectedSessionId === id) {
      const next = this.list().find((candidate) => this.isOpen(candidate.id));
      this.selectedSessionId = next?.id;
      this.selectedEmitter.fire(next);
    }
    await this.persistAndNotify();
  }

  public async unarchiveSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.archivedAt) {
      return;
    }
    delete session.archivedAt;
    session.updatedAt = Date.now();
    await this.persistAndNotify();
  }

  public async deleteClosedHistory(): Promise<number> {
    const removable = this.history().filter(
      (session) =>
        !this.isOpen(session.id) &&
        (session.archivedAt !== undefined || session.status === 'closed')
    );
    for (const session of removable) {
      this.sessions.delete(session.id);
      this.eventLedger = removeSessionEvents(this.eventLedger, session.id);
    }
    if (removable.length > 0) {
      await this.persistAndNotify();
    }
    return removable.length;
  }

  public async focusNextAttention(): Promise<void> {
    // Only sessions with an open terminal can be focused; a closed session
    // must not become a dead end that hides the next real candidate.
    const sessions = this.list().filter((candidate) => this.isOpen(candidate.id));
    const session =
      sessions.find(
        (candidate) => candidate.status === 'attention' && candidate.unread
      ) ??
      sessions.find((candidate) => candidate.unread);
    if (!session) {
      void vscode.window.showInformationMessage('No agents need attention.');
      return;
    }
    await this.focus(session.id);
  }

  public async focusAdjacentUnread(direction: 1 | -1): Promise<void> {
    const unread = this.eventLedger.events
      .filter(
        (event) =>
          event.readAt === undefined &&
          event.attention !== 'none' &&
          this.isOpen(event.sessionId)
      )
      .sort((left, right) => left.sequence - right.sequence);
    if (unread.length === 0) {
      void vscode.window.showInformationMessage('No unread agent events.');
      return;
    }
    const currentIndex = unread.findIndex(
      (event) => event.sessionId === this.selectedSessionId
    );
    const nextIndex =
      currentIndex < 0
        ? direction === 1
          ? 0
          : unread.length - 1
        : (currentIndex + direction + unread.length) % unread.length;
    await this.focus(unread[nextIndex].sessionId);
  }

  public async focusAdjacent(direction: 1 | -1): Promise<void> {
    const openSessions = [...this.sessions.values()]
      .filter((session) => this.isOpen(session.id))
      .sort((left, right) => left.createdAt - right.createdAt);
    if (openSessions.length === 0) {
      void vscode.window.showInformationMessage('No agent terminals are open.');
      return;
    }
    const currentIndex = openSessions.findIndex(
      (session) => session.id === this.selectedSessionId
    );
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + direction + openSessions.length) % openSessions.length;
    await this.focus(openSessions[nextIndex].id);
  }

  public async close(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    const session = this.sessions.get(id);
    if (terminal && session) {
      const running = isActiveSession(session);
      let uncommittedCount = 0;
      if (session.baseline) {
        try {
          uncommittedCount = (
            await listUncommittedChanges(session.baseline.repoRoot)
          ).length;
        } catch {
          // An unreadable Git state should not make a session impossible to remove.
        }
      }
      if (running || uncommittedCount > 0) {
        const risks = [
          ...(running ? ['its agent command is still running'] : []),
          ...(uncommittedCount > 0
            ? [`its worktree has ${uncommittedCount} uncommitted file${uncommittedCount === 1 ? '' : 's'}`]
            : [])
        ];
        const detail = joinRisks(risks);
        const choice = await vscode.window.showWarningMessage(
          `Remove ${session.label}? ${detail.charAt(0).toUpperCase()}${detail.slice(1)}. Removing the agent closes its terminal and removes its Lookout review baseline. It does not delete worktree files or Git commits.`,
          { modal: true },
          'Review Changes',
          'Remove Agent'
        );
        if (choice === 'Review Changes') {
          this.selectSession(id);
          await vscode.commands.executeCommand('workbench.view.extension.lookout');
          return;
        }
        if (choice !== 'Remove Agent') {
          return;
        }
      }
    }
    if (terminal) {
      this.terminals.delete(id);
      this.agentExecutions.delete(id);
      this.agentLaunchesInFlight.delete(id);
      this.untrackedAgentCommands.delete(id);
      this.restartsInFlight.delete(id);
      this.sessionIdsByTerminal.delete(terminal);
      terminal.dispose();
    }
    this.agentLaunchesInFlight.delete(id);
    this.untrackedAgentCommands.delete(id);
    this.restartsInFlight.delete(id);
    await this.deleteClaudeSettings(id);
    this.commandResults.delete(id);
    this.pendingDelegatedUsage.delete(id);
    this.delegatedUsageObservedAt.delete(id);
    this.eventLedger = removeSessionEvents(this.eventLedger, id);
    if (!this.sessions.delete(id)) {
      return;
    }
    if (this.selectedSessionId === id) {
      const next = this.list().find((session) => this.isOpen(session.id));
      this.selectedSessionId = next?.id;
      this.selectedEmitter.fire(next);
    }
    this.topologyEmitter.fire();
    await this.persistAndNotify();
  }

  public async restart(id: string): Promise<void> {
    const session = this.sessions.get(id);
    const terminal = this.terminals.get(id);
    if (!session || !terminal) {
      void vscode.window.showWarningMessage('Reopen the agent before restarting it.');
      return;
    }
    if (!session.command) {
      void vscode.window.showWarningMessage(
        'This session has no stored launch command — adopted terminals and restored custom sessions do not keep one. Launch a new agent instead.'
      );
      return;
    }
    if (this.agentExecutions.has(id)) {
      void vscode.window.showWarningMessage(
        'Stop the running agent command before restarting it.'
      );
      return;
    }
    if (this.agentLaunchesInFlight.has(id) || this.restartsInFlight.has(id)) {
      void vscode.window.showWarningMessage(
        'The agent command is already starting. Wait for it to settle before restarting it.'
      );
      return;
    }
    if (this.untrackedAgentCommands.has(id)) {
      void vscode.window.showWarningMessage(
        'Lookout cannot confirm that this untracked agent command has ended. Close this terminal and launch a new agent instead.'
      );
      return;
    }
    this.restartsInFlight.add(id);
    try {
      session.status = 'starting';
      session.unread = false;
      session.backgroundAgents = [];
      session.runningCommands = [];
      session.tokenUsage = undefined;
      this.commandResults.delete(id);
      this.pendingDelegatedUsage.delete(id);
      this.delegatedUsageObservedAt.delete(id);
      session.foregroundState = 'unknown';
      session.latestEvent = 'Restarting agent command';
      session.updatedAt = Date.now();
      await this.persistAndNotify();
      terminal.show(false);
      const launched = await this.prepareLaunchCommand(
        {
          kind: session.kind,
          label: session.label,
          command: session.command,
          cwd: session.cwd
        },
        id,
        classifyShell(vscode.env.shell),
        session.tokenBudget
      );
      await this.executeAgentCommand(
        id,
        terminal,
        launched.command,
        launched.integrationsSkipped
          ? 'Agent session active · hooks unavailable in this terminal shell'
          : undefined
      );
    } finally {
      this.restartsInFlight.delete(id);
    }
  }

  public async rename(id: string, label: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.label = label.trim();
    session.updatedAt = Date.now();
    this.recordEvent(id, 'session-renamed', 'user', 'Agent session renamed');
    await this.persistAndNotify();
  }

  public markAttention(id: string, message = 'Agent needs attention'): void {
    if (this.sessions.get(id)?.status === 'closed') {
      void vscode.window.showInformationMessage(
        'That agent terminal is closed; there is nothing to attend to.'
      );
      return;
    }
    this.updateSession(id, 'attention', undefined, message);
  }

  public notifyCommand(id: string): string | undefined {
    if (!this.sessions.get(id)?.bridgeAvailable) {
      return undefined;
    }
    const helperPath = path.join(this.context.extensionPath, 'out', 'src', 'notify.js');
    const shell = classifyShell(vscode.env.shell);
    return `node ${shellQuote(
      helperPath,
      shell === 'unknown' ? hookRunnerShell() : shell
    )} attention`;
  }

  public toggleAttentionSound(): Promise<void> {
    return this.attentionSound.toggle();
  }

  public setAttentionSoundEnabled(enabled: boolean): Promise<void> {
    return this.attentionSound.setEnabled(enabled);
  }

  public testAttentionSound(): Promise<void> {
    return this.attentionSound.play();
  }

  public dispose(): void {
    this.attentionServer.dispose();
    this.attentionSound.dispose();
    this.changedEmitter.dispose();
    this.topologyEmitter.dispose();
    this.selectedEmitter.dispose();
    this.usageEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private attachTerminal(id: string, terminal: vscode.Terminal): void {
    this.terminals.set(id, terminal);
    this.sessionIdsByTerminal.set(terminal, id);
  }

  private async executeAgentCommand(
    id: string,
    terminal: vscode.Terminal,
    command: string,
    activeMessage = 'Agent session active'
  ): Promise<void> {
    this.agentLaunchesInFlight.add(id);
    try {
      const shellIntegration = await waitForShellIntegration(terminal, 2_000);
      if (shellIntegration) {
        try {
          const execution = shellIntegration.executeCommand(command);
          this.agentExecutions.set(id, execution);
          this.untrackedAgentCommands.delete(id);
          this.updateSession(id, 'active', undefined, activeMessage);
          return;
        } catch {
          // Fall through to sendText for terminals that reject execution tracking.
        }
      }
      this.untrackedAgentCommands.add(id);
      terminal.sendText(command, true);
      this.updateSession(
        id,
        'active',
        undefined,
        `${activeMessage} · detailed lifecycle unavailable`
      );
    } finally {
      this.agentLaunchesInFlight.delete(id);
    }
  }

  private markRead(id: string): void {
    const session = this.sessions.get(id);
    const marked = markSessionEventsRead(this.eventLedger, id);
    const eventsChanged = marked !== this.eventLedger;
    this.eventLedger = marked;
    if (!session?.unread && !eventsChanged) {
      return;
    }
    if (session?.unread) {
      this.sessions.set(id, markSessionRead(session));
    }
    void this.persistAndNotify();
  }

  private updateSession(
    id: string,
    status: AgentSession['status'],
    exitCode?: number,
    message?: string
  ): void {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    const resetActivity =
      status === 'active'
        ? {
            ...session,
            backgroundAgents: [],
            runningCommands: [],
            foregroundState: 'unknown' as const
          }
        : status === 'completed' ||
            status === 'failed' ||
            status === 'unknown' ||
            status === 'closed'
          ? {
              ...session,
              backgroundAgents: [],
              runningCommands: [],
              foregroundState: 'stopped' as const
            }
          : session;
    let updated = transitionSession(
      resetActivity,
      status,
      Date.now(),
      exitCode,
      message
    );
    if (
      vscode.window.state.focused &&
      this.terminals.get(id) === vscode.window.activeTerminal &&
      updated.unread
    ) {
      updated = markSessionRead(updated);
    }
    this.sessions.set(id, updated);
    void this.persistAndNotify();
  }

  private selectSession(id: string): void {
    if (this.selectedSessionId === id) {
      return;
    }
    this.selectedSessionId = id;
    this.selectedEmitter.fire(this.sessions.get(id));
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session || !this.terminals.has(event.sessionId)) {
      return;
    }
    const providerSessionId = event.providerSessionId;
    const provider = event.provider;
    const collision =
      provider && providerSessionId
        ? providerSessionCollision(
            this.list(),
            event.sessionId,
            provider,
            providerSessionId,
            (id) => this.isOpen(id)
          )
        : undefined;
    const binding = collision
      ? {
          session: {
            ...session,
            integration: {
              ...session.integration,
              lifecycle: 'stale' as const,
              lastHookAt: Date.now(),
              conflict: `Provider session is already open as ${collision.label}`
            }
          },
          changed: true,
          conflict: `Provider session is already open as ${collision.label}`
        }
      : bindProviderSession(session, event);
    let updated = applyAgentEvent(binding.session, event);
    this.eventLedger = appendSessionEvent(
      this.eventLedger,
      eventFromAgentEvent(event)
    );
    const identityChanged =
      providerSessionId !== undefined &&
      session.providerSessions.at(-1)?.id !== providerSessionId;
    if ((binding.conflict || identityChanged) && providerSessionId) {
      this.recordEvent(
        event.sessionId,
        binding.conflict ? 'identity-conflict' : 'identity-observed',
        'provider-hook',
        binding.conflict
          ? 'Provider session identity conflict'
          : 'Provider session identity observed',
        binding.conflict ? 'action' : 'none',
        provider,
        providerSessionId
      );
    }
    if (
      event.kind === 'command-stop' &&
      event.result &&
      this.captureCommandOutputEnabled()
    ) {
      const results = this.commandResults.get(event.sessionId) ?? [];
      const result: CommandResult = {
        id: `${event.commandId}-${++this.commandResultSequence}`,
        command: event.command,
        completedAt: Date.now(),
        ...event.result
      };
      this.commandResults.set(
        event.sessionId,
        [...results, result].slice(
          -MAX_COMMAND_RESULTS_PER_SESSION
        )
      );
    }
    const terminal = this.terminals.get(event.sessionId);
    if (
      vscode.window.state.focused &&
      terminal === vscode.window.activeTerminal &&
      updated.unread
    ) {
      updated = markSessionRead(updated);
    }
    this.sessions.set(event.sessionId, updated);
    await this.persistAndNotify();
    const configuration = vscode.workspace.getConfiguration('lookout');
    const shouldNotify =
      (updated.status === 'attention' &&
        configuration.get('notifyOnAttention', true)) ||
      ((updated.status === 'idle' ||
        updated.status === 'completed' ||
        updated.status === 'failed') &&
        configuration.get('notifyOnTurnComplete', true));
    const enteredAttention =
      updated.status === 'attention' && session.status !== 'attention';
    const enteredTurnComplete =
      (updated.status === 'idle' ||
        updated.status === 'completed' ||
        updated.status === 'failed') &&
      updated.status !== session.status;
    const terminalIsUnattended =
      !vscode.window.state.focused || vscode.window.activeTerminal !== terminal;
    if ((enteredAttention || enteredTurnComplete) && terminalIsUnattended) {
      void this.attentionSound.play();
    }
    if (shouldNotify && terminalIsUnattended) {
      const choice = await vscode.window.showInformationMessage(
        `${session.label}: ${updated.latestEvent ?? updated.status}`,
        'Focus Agent'
      );
      if (choice) {
        await this.focus(event.sessionId);
      }
    }
  }

  private persistAndNotify(): Promise<void> {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() =>
        this.sessionStore.save(
          this.list(),
          this.eventLedger.events,
          this.eventLedger.nextSequence
        )
      );
    this.changedEmitter.fire();
    return this.persistChain;
  }

  private recordEvent(
    sessionId: string,
    kind: SessionEventKind,
    source: SessionEventSource,
    summary: string,
    attention: SessionEvent['attention'] = 'none',
    provider?: AgentEvent['provider'],
    providerSessionId?: string
  ): void {
    this.eventLedger = appendSessionEvent(this.eventLedger, {
      sessionId,
      kind,
      source,
      summary,
      attention,
      observedAt: Date.now(),
      ...(provider ? { provider } : {}),
      ...(providerSessionId ? { providerSessionId } : {})
    });
  }

  private captureCommandOutputEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('lookout.review')
      .get('captureCommandOutput', false);
  }

  private handleUsageEvent(event: UsageBridgeEvent): void {
    if (!event.sessionId) {
      return;
    }
    const session = this.sessions.get(event.sessionId);
    if (!session || session.kind !== 'claude') {
      return;
    }
    if (event.kind === 'delegated-agents') {
      const previousObservedAt =
        this.delegatedUsageObservedAt.get(event.sessionId) ?? -1;
      if (event.observedAt < previousObservedAt) {
        return;
      }
      this.delegatedUsageObservedAt.set(event.sessionId, event.observedAt);
      if (!session.tokenUsage) {
        this.pendingDelegatedUsage.set(
          event.sessionId,
          {
            observedAt: event.observedAt,
            delegatedAgents: event.delegatedAgents
          }
        );
        return;
      }
      session.tokenUsage = {
        ...session.tokenUsage,
        delegatedAgents: event.delegatedAgents
      };
      session.updatedAt = Math.max(session.updatedAt, event.observedAt);
      void this.persistAndNotify();
      return;
    }
    if (!event.tokenUsage) {
      return;
    }
    if (
      session.tokenUsage &&
      event.observedAt < session.tokenUsage.observedAt
    ) {
      return;
    }
    const pendingDelegated = this.pendingDelegatedUsage.get(event.sessionId);
    this.pendingDelegatedUsage.delete(event.sessionId);
    const delegatedUsage = latestDelegatedTokenUsage(
      {
        observedAt: event.observedAt,
        delegatedAgents: event.tokenUsage.delegatedAgents
      },
      {
        observedAt: this.delegatedUsageObservedAt.get(event.sessionId) ?? -1,
        delegatedAgents: session.tokenUsage?.delegatedAgents ?? []
      },
      pendingDelegated
    );
    this.delegatedUsageObservedAt.set(
      event.sessionId,
      delegatedUsage.observedAt
    );
    session.tokenUsage = {
      ...event.tokenUsage,
      observedAt: event.observedAt,
      delegatedAgents: delegatedUsage.delegatedAgents
    };
    session.updatedAt = Math.max(session.updatedAt, event.observedAt);
    void this.persistAndNotify();
  }

  private async prepareLaunchCommand(
    request: LaunchRequest,
    lookoutSessionId: string,
    launchShell: LaunchShell,
    tokenBudget?: AgentSession['tokenBudget']
  ): Promise<{ command: string; integrationsSkipped: boolean }> {
    let command = request.command;
    if (request.kind === 'codex' && tokenBudget?.kind === 'codex-rollout') {
      command = withCodexTokenBudget(
        command,
        tokenBudget.limitTokens,
        launchShell
      );
    }
    const notifyHelperPath = path.join(
      this.context.extensionPath,
      'out',
      'src',
      'notify.js'
    );
    if (
      request.kind === 'codex' &&
      this.attentionEndpoint &&
      vscode.workspace
        .getConfiguration('lookout.codex')
        .get('lifecycleIntegration', true)
    ) {
      const lifecycleCommand = withCodexLifecycleIntegration(
        command,
        notifyHelperPath,
        launchShell
      );
      return {
        command: lifecycleCommand,
        integrationsSkipped:
          !isDirectAgentCommand(request.command, 'codex') ||
          launchShell === 'unknown'
      };
    }
    if (request.kind === 'codex' || !this.attentionEndpoint) {
      return { command, integrationsSkipped: false };
    }
    if (
      request.kind !== 'claude' ||
      /(^|\s)--settings(?:\s|=)/.test(request.command) ||
      !isDirectClaudeCommand(request.command)
    ) {
      return {
        command,
        integrationsSkipped:
          request.kind === 'claude' &&
          vscode.workspace
            .getConfiguration('lookout.claude')
            .get('lifecycleIntegration', true)
      };
    }
    const statusLineIntegration = vscode.workspace
      .getConfiguration('lookout.usage.claude')
      .get('statusLineIntegration', true);
    const lifecycleIntegration = vscode.workspace
      .getConfiguration('lookout.claude')
      .get('lifecycleIntegration', true);
    if (!statusLineIntegration && !lifecycleIntegration) {
      return { command: request.command, integrationsSkipped: false };
    }
    if (launchShell === 'unknown') {
      // No known-safe way to quote the settings path for this shell.
      return { command: request.command, integrationsSkipped: true };
    }
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const helperPath = path.join(
      this.context.extensionPath,
      'out',
      'src',
      'claudeStatusLine.js'
    );
    const settingsUri = this.claudeSettingsUri(lookoutSessionId);
    const hooks = {
      SessionStart: [hookGroup(notifyHelperPath, 'session-start')],
      UserPromptSubmit: [
        hookGroup(notifyHelperPath, 'running', 'Claude is working')
      ],
      Notification: [
        {
          matcher: 'permission_prompt',
          ...hookGroup(
            notifyHelperPath,
            'attention',
            'Claude needs permission'
          )
        },
        {
          matcher: 'idle_prompt',
          ...hookGroup(
            notifyHelperPath,
            'foreground-stop',
            'Claude is waiting for input'
          )
        }
      ],
      Stop: [
        hookGroup(
          notifyHelperPath,
          'turn-end',
          'Claude finished'
        )
      ],
      SubagentStart: [hookGroup(notifyHelperPath, 'background-start')],
      SubagentStop: [hookGroup(notifyHelperPath, 'background-stop')],
      StopFailure: [hookGroup(notifyHelperPath, 'failed', 'Claude turn failed')],
      // Surface shell commands and MCP calls while they execute. Quick calls
      // finish before their start is ever seen.
      PreToolUse: [
        {
          matcher: PROVIDER_ACTIVITY_TOOL_MATCHER,
          ...hookGroup(notifyHelperPath, 'command-start')
        }
      ],
      PostToolUse: [
        {
          matcher: PROVIDER_ACTIVITY_TOOL_MATCHER,
          ...hookGroup(notifyHelperPath, 'command-stop')
        }
      ],
      PostToolUseFailure: [
        {
          matcher: PROVIDER_ACTIVITY_TOOL_MATCHER,
          ...hookGroup(notifyHelperPath, 'command-stop')
        }
      ]
    };
    const settings = {
      ...(statusLineIntegration
        ? {
            statusLine: {
              type: 'command',
              command: `node ${shellQuote(helperPath, hookRunnerShell())}`
            },
            subagentStatusLine: {
              type: 'command',
              command: `node ${shellQuote(
                helperPath,
                hookRunnerShell()
              )} --subagents`
            }
          }
        : {}),
      ...(lifecycleIntegration ? { hooks } : {})
    };
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(JSON.stringify(settings), 'utf8')
    );
    return {
      command: `${request.command} --settings ${shellQuote(
        settingsUri.fsPath,
        launchShell
      )}`,
      integrationsSkipped: false
    };
  }

  private claudeSettingsUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `claude-lookout-settings-${safeStorageSegment(id)}.json`
    );
  }

  private async deleteClaudeSettings(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.claudeSettingsUri(id), {
        useTrash: false
      });
    } catch {
      // Missing or locked cleanup files must not prevent session removal.
    }
  }

  private async showCodexHookNotice(id: string): Promise<void> {
    if (this.context.globalState.get<boolean>(CODEX_HOOK_NOTICE_KEY, false)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'To track delegated Codex agents, run /hooks in this Codex terminal and trust the Lookout lifecycle hooks once.',
      'Focus Agent',
      "Don't Remind Me"
    );
    if (!choice) {
      return;
    }
    await this.context.globalState.update(CODEX_HOOK_NOTICE_KEY, true);
    if (choice === 'Focus Agent') {
      await this.focus(id);
    }
  }
}

function configuredTokenBudget(
  kind: AgentSession['kind'],
  command: string
): AgentSession['tokenBudget'] | undefined {
  if (
    kind === 'codex' &&
    isDirectAgentCommand(command, 'codex') &&
    !/(?:^|\s)(?:-c|--config)(?:\s+|=)\s*['"]?features\.rollout_budget\./.test(
      command
    )
  ) {
    const limitTokens = Math.floor(
      vscode.workspace
        .getConfiguration('lookout.usage.codex')
        .get('tokenBudget', 0)
    );
    return limitTokens > 0
      ? { kind: 'codex-rollout', limitTokens }
      : undefined;
  }
  if (
    kind === 'claude' &&
    isDirectClaudeCommand(command) &&
    !/(^|\s)--settings(?:\s|=)/.test(command) &&
    vscode.workspace
      .getConfiguration('lookout.usage.claude')
      .get('statusLineIntegration', true)
  ) {
    const limitTokens = Math.floor(
      vscode.workspace
        .getConfiguration('lookout.usage.claude')
        .get('contextWarningTokens', 0)
    );
    return limitTokens > 0
      ? { kind: 'claude-context-warning', limitTokens }
      : undefined;
  }
  return undefined;
}

function joinRisks(risks: readonly string[]): string {
  if (risks.length <= 1) {
    return risks[0] ?? '';
  }
  return `${risks.slice(0, -1).join(', ')} and ${risks.at(-1)}`;
}

type HookAction =
  | AgentReportedStatus
  | 'foreground-stop'
  | 'turn-end'
  | 'background-start'
  | 'background-stop'
  | 'command-start'
  | 'command-stop'
  | 'session-start';

function hookGroup(
  helperPath: string,
  action: HookAction,
  message?: string
): { hooks: Array<{ type: 'command'; command: string }> } {
  // Hook commands in the settings file are run by Claude's own hook runner
  // (cmd on Windows, sh elsewhere), not by the terminal's launch shell.
  const shell = hookRunnerShell();
  return {
    hooks: [
      {
        type: 'command',
        command: [
          'node',
          shellQuote(helperPath, shell),
          '--hook',
          'claude',
          action,
          ...(message ? [shellQuote(message, shell)] : [])
        ].join(' ')
      }
    ]
  };
}

const isDirectClaudeCommand = (command: string): boolean =>
  isDirectAgentCommand(command, 'claude');

function safeStorageSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
  return sanitized || 'session';
}

function sessionIdFromTerminal(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions;
  if (!('env' in options) || !options.env) {
    return undefined;
  }
  const sessionId = options.env.LOOKOUT_SESSION_ID;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function sameEndpoint(
  left: AttentionEndpoint | undefined,
  right: AttentionEndpoint
): boolean {
  return left?.url === right.url && left.token === right.token;
}

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      shellIntegration: vscode.TerminalShellIntegration | undefined
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(shellIntegration);
    };
    const subscription = vscode.window.onDidChangeTerminalShellIntegration(
      (event) => {
        if (event.terminal === terminal) {
          finish(event.shellIntegration);
        }
      }
    );
    const timer = setTimeout(() => finish(terminal.shellIntegration), timeoutMs);
  });
}

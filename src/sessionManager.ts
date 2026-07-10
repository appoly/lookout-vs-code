import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  AttentionServer,
  type AttentionEndpoint
} from './attentionServer';
import { AttentionSound } from './attentionSound';
import {
  isDirectAgentCommand,
  shellQuote,
  withCodexLifecycleIntegration
} from './agentCommand';
import { captureGitBaseline } from './gitReview';
import {
  createSession,
  isActiveSession,
  markSessionRead,
  transitionSession
} from './sessionModel';
import {
  applyAgentEvent,
  normalizeSessionActivity
} from './sessionActivity';
import type {
  AgentEvent,
  AgentReportedStatus,
  AgentSession,
  LaunchRequest
} from './types';
import type { UsageBridgeEvent } from './usageTypes';

const STORAGE_KEY = 'parful.sessions.v1';
const BRIDGE_STORAGE_KEY = 'parful.attentionEndpoint.v1';
const CODEX_HOOK_NOTICE_KEY = 'parful.codexHookNotice.v1';

export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly agentExecutions = new Map<
    string,
    vscode.TerminalShellExecution
  >();
  private readonly sessionIdsByTerminal = new Map<vscode.Terminal, string>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly topologyEmitter = new vscode.EventEmitter<void>();
  private readonly selectedEmitter = new vscode.EventEmitter<AgentSession | undefined>();
  private readonly usageEmitter = new vscode.EventEmitter<UsageBridgeEvent>();
  private readonly attentionServer = new AttentionServer((event) => {
    void this.handleAgentEvent(event);
  }, (event) => this.usageEmitter.fire(event));
  private readonly disposables: vscode.Disposable[] = [];
  private selectedSessionId: string | undefined;
  private persistChain: Promise<void> = Promise.resolve();
  private attentionEndpoint: AttentionEndpoint | undefined;
  private bridgeWarningShown = false;
  private readonly attentionSound: AttentionSound;

  public readonly onDidChange = this.changedEmitter.event;
  public readonly onDidChangeTopology = this.topologyEmitter.event;
  public readonly onDidSelectSession = this.selectedEmitter.event;
  public readonly onDidReceiveUsage = this.usageEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.attentionSound = new AttentionSound(context);
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
    const stored = this.context.workspaceState.get<AgentSession[]>(STORAGE_KEY, []);
    const terminalsByName = new Map(
      vscode.window.terminals.map((terminal) => [terminal.name, terminal])
    );
    const terminalsBySessionId = new Map<string, vscode.Terminal>();
    for (const terminal of vscode.window.terminals) {
      const sessionId = sessionIdFromTerminal(terminal);
      if (sessionId) {
        terminalsBySessionId.set(sessionId, terminal);
      }
    }

    for (const saved of stored) {
      const normalizedSaved = normalizeSessionActivity(saved);
      const terminal =
        terminalsBySessionId.get(saved.id) ?? terminalsByName.get(saved.terminalName);
      const session: AgentSession = terminal
        ? {
            ...normalizedSaved,
            bridgeAvailable: bridgeReused,
            ...(!bridgeReused
              ? {
                  backgroundAgents: [],
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
            foregroundState: 'stopped'
          };
      this.sessions.set(session.id, session);
      if (terminal) {
        this.attachTerminal(session.id, terminal);
      }
    }
    this.selectedSessionId =
      stored.find((session) => this.terminals.has(session.id))?.id ?? stored[0]?.id;

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const id = this.sessionIdsByTerminal.get(event.terminal);
        if (id && this.agentExecutions.get(id) === event.execution) {
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
          vscode.workspace.getConfiguration('parful').get('notifyOnAgentExit', true) &&
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
        this.sessionIdsByTerminal.delete(terminal);
        this.topologyEmitter.fire();
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
      })
    );
    this.changedEmitter.fire();
  }

  public list(): readonly AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
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
    const session: AgentSession = {
      ...createSession(
        request.kind,
        request.label,
        request.command,
        request.cwd
      ),
      bridgeAvailable: this.attentionEndpoint !== undefined,
      ...(baseline ? { baseline } : {})
    };
    const parentTerminal = request.parentSessionId
      ? this.terminals.get(request.parentSessionId)
      : undefined;
    const configuredLocation = vscode.workspace
      .getConfiguration('parful')
      .get<'editor' | 'panel'>('terminals.location', 'editor');
    const endpoint = this.attentionEndpoint;
    const location: vscode.TerminalOptions['location'] = parentTerminal
      ? { parentTerminal }
      : configuredLocation === 'editor'
        ? { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }
        : vscode.TerminalLocation.Panel;

    if (parentTerminal) {
      parentTerminal.show(false);
    }

    const launchCommand = await this.prepareLaunchCommand(request);
    const terminal = vscode.window.createTerminal({
      name: session.terminalName,
      cwd: vscode.Uri.file(request.cwd),
      location,
      iconPath: new vscode.ThemeIcon(request.kind === 'claude' ? 'sparkle' : 'terminal'),
      env: {
        PARFUL_SESSION_ID: session.id,
        ...(endpoint
          ? {
              PARFUL_NOTIFY_URL: endpoint.url,
              PARFUL_NOTIFY_TOKEN: endpoint.token,
              PARFUL_NOTIFY_HELPER: path.join(
                this.context.extensionPath,
                'out',
                'src',
                'notify.js'
              ),
              PARFUL_USAGE_URL: endpoint.url.replace(/\/events$/, '/usage')
            }
          : {})
      }
    });
    this.sessions.set(session.id, session);
    this.attachTerminal(session.id, terminal);
    this.topologyEmitter.fire();
    this.selectSession(session.id);
    await this.persistAndNotify();
    terminal.show(false);
    await this.executeAgentCommand(session.id, terminal, launchCommand);
    if (
      request.kind === 'codex' &&
      launchCommand.includes('hooks.SubagentStart=')
    ) {
      void this.showCodexHookNotice(session.id);
    }
    if (!endpoint && !this.bridgeWarningShown) {
      this.bridgeWarningShown = true;
      void vscode.window.showWarningMessage(
        'Parful could not start its local attention bridge. Terminals still work, but agent hooks and Claude usage updates are unavailable.'
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
      latestEvent: 'Adopted terminal · lifecycle hooks unavailable',
      ...(baseline ? { baseline } : {})
    };
    this.sessions.set(session.id, session);
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

  public async focusNextAttention(): Promise<void> {
    const session = this.list().find((candidate) => candidate.unread);
    if (!session) {
      void vscode.window.showInformationMessage('No agents need attention.');
      return;
    }
    await this.focus(session.id);
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
    if (terminal) {
      this.terminals.delete(id);
      this.agentExecutions.delete(id);
      this.sessionIdsByTerminal.delete(terminal);
      terminal.dispose();
    }
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
        'This restored custom session did not persist its command. Launch it again instead.'
      );
      return;
    }
    if (this.agentExecutions.has(id)) {
      void vscode.window.showWarningMessage(
        'Stop the running agent command before restarting it.'
      );
      return;
    }
    session.status = 'starting';
    session.unread = false;
    session.backgroundAgents = [];
    session.foregroundState = 'unknown';
    session.latestEvent = 'Restarting agent command';
    session.updatedAt = Date.now();
    await this.persistAndNotify();
    terminal.show(false);
    const launchCommand = await this.prepareLaunchCommand({
      kind: session.kind,
      label: session.label,
      command: session.command,
      cwd: session.cwd
    });
    await this.executeAgentCommand(id, terminal, launchCommand);
  }

  public async rename(id: string, label: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.label = label.trim();
    session.updatedAt = Date.now();
    await this.persistAndNotify();
  }

  public markAttention(id: string, message = 'Agent needs attention'): void {
    this.updateSession(id, 'attention', undefined, message);
  }

  public notifyCommand(id: string): string | undefined {
    if (!this.sessions.get(id)?.bridgeAvailable) {
      return undefined;
    }
    const helperPath = path.join(this.context.extensionPath, 'out', 'src', 'notify.js');
    return `node ${shellQuote(helperPath)} attention`;
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
    command: string
  ): Promise<void> {
    const shellIntegration = await waitForShellIntegration(terminal, 2_000);
    if (shellIntegration) {
      try {
        const execution = shellIntegration.executeCommand(command);
        this.agentExecutions.set(id, execution);
        this.updateSession(id, 'active', undefined, 'Agent session active');
        return;
      } catch {
        // Fall through to sendText for terminals that reject execution tracking.
      }
    }
    terminal.sendText(command, true);
    this.updateSession(
      id,
      'active',
      undefined,
      'Agent session active · detailed lifecycle unavailable'
    );
  }

  private markRead(id: string): void {
    const session = this.sessions.get(id);
    if (!session?.unread) {
      return;
    }
    this.sessions.set(id, markSessionRead(session));
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
        ? { ...session, backgroundAgents: [], foregroundState: 'unknown' as const }
        : status === 'completed' ||
            status === 'failed' ||
            status === 'unknown' ||
            status === 'closed'
          ? { ...session, backgroundAgents: [], foregroundState: 'stopped' as const }
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
    let updated = applyAgentEvent(session, event);
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
    const configuration = vscode.workspace.getConfiguration('parful');
    const shouldNotify =
      (updated.status === 'attention' &&
        configuration.get('notifyOnAttention', true)) ||
      ((updated.status === 'completed' || updated.status === 'failed') &&
        configuration.get('notifyOnTurnComplete', true));
    const enteredAttention =
      updated.status === 'attention' && session.status !== 'attention';
    const enteredTurnComplete =
      (updated.status === 'completed' || updated.status === 'failed') &&
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
    const snapshot = this.list().map((session) => ({
      ...session,
      ...(session.kind === 'custom' ? { command: '' } : {})
    }));
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.context.workspaceState.update(STORAGE_KEY, snapshot));
    this.changedEmitter.fire();
    return this.persistChain;
  }

  private async prepareLaunchCommand(request: LaunchRequest): Promise<string> {
    if (!this.attentionEndpoint) {
      return request.command;
    }
    const notifyHelperPath = path.join(
      this.context.extensionPath,
      'out',
      'src',
      'notify.js'
    );
    if (
      request.kind === 'codex' &&
      vscode.workspace
        .getConfiguration('parful.codex')
        .get('lifecycleIntegration', true)
    ) {
      return withCodexLifecycleIntegration(request.command, notifyHelperPath);
    }
    if (
      request.kind !== 'claude' ||
      /(^|\s)--settings(?:\s|=)/.test(request.command) ||
      !isDirectClaudeCommand(request.command)
    ) {
      return request.command;
    }
    const statusLineIntegration = vscode.workspace
      .getConfiguration('parful.usage.claude')
      .get('statusLineIntegration', true);
    const lifecycleIntegration = vscode.workspace
      .getConfiguration('parful.claude')
      .get('lifecycleIntegration', true);
    if (!statusLineIntegration && !lifecycleIntegration) {
      return request.command;
    }
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const helperPath = path.join(
      this.context.extensionPath,
      'out',
      'src',
      'claudeStatusLine.js'
    );
    const settingsUri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      'claude-parful-settings.json'
    );
    const hooks = {
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
          'foreground-stop',
          'Claude is waiting for input'
        )
      ],
      SubagentStart: [hookGroup(notifyHelperPath, 'background-start')],
      SubagentStop: [hookGroup(notifyHelperPath, 'background-stop')],
      StopFailure: [hookGroup(notifyHelperPath, 'failed', 'Claude turn failed')]
    };
    const settings = {
      ...(statusLineIntegration
        ? {
            statusLine: {
              type: 'command',
              command: `node ${shellQuote(helperPath)}`
            }
          }
        : {}),
      ...(lifecycleIntegration ? { hooks } : {})
    };
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(JSON.stringify(settings), 'utf8')
    );
    return `${request.command} --settings ${shellQuote(settingsUri.fsPath)}`;
  }

  private async showCodexHookNotice(id: string): Promise<void> {
    if (this.context.globalState.get<boolean>(CODEX_HOOK_NOTICE_KEY, false)) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'To track delegated Codex agents, run /hooks in this Codex terminal and trust the Parful lifecycle hooks once.',
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

type HookAction =
  | AgentReportedStatus
  | 'foreground-stop'
  | 'background-start'
  | 'background-stop';

function hookGroup(
  helperPath: string,
  action: HookAction,
  message?: string
): { hooks: Array<{ type: 'command'; command: string }> } {
  return {
    hooks: [
      {
        type: 'command',
        command: [
          'node',
          shellQuote(helperPath),
          '--hook',
          'claude',
          action,
          ...(message ? [shellQuote(message)] : [])
        ].join(' ')
      }
    ]
  };
}

const isDirectClaudeCommand = (command: string): boolean =>
  isDirectAgentCommand(command, 'claude');

function sessionIdFromTerminal(terminal: vscode.Terminal): string | undefined {
  const options = terminal.creationOptions;
  if (!('env' in options) || !options.env) {
    return undefined;
  }
  const sessionId = options.env.PARFUL_SESSION_ID;
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

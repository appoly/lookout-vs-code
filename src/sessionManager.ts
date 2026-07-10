import * as path from 'node:path';
import * as vscode from 'vscode';
import { AttentionServer } from './attentionServer';
import {
  createSession,
  isActiveSession,
  markSessionRead,
  terminalName,
  transitionSession
} from './sessionModel';
import type { AgentEvent, AgentSession, LaunchRequest } from './types';
import type { UsageBridgeEvent } from './usageTypes';

const STORAGE_KEY = 'multiTerm.sessions.v1';

export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly sessionIdsByTerminal = new Map<vscode.Terminal, string>();
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly usageEmitter = new vscode.EventEmitter<UsageBridgeEvent>();
  private readonly attentionServer = new AttentionServer((event) => {
    void this.handleAgentEvent(event);
  }, (event) => this.usageEmitter.fire(event));
  private readonly disposables: vscode.Disposable[] = [];

  public readonly onDidChange = this.changedEmitter.event;
  public readonly onDidReceiveUsage = this.usageEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    await this.attentionServer.start();
    const stored = this.context.workspaceState.get<AgentSession[]>(STORAGE_KEY, []);
    const availableTerminals = new Map(
      vscode.window.terminals.map((terminal) => [terminal.name, terminal])
    );

    for (const saved of stored) {
      const terminal = availableTerminals.get(saved.terminalName);
      const session = terminal
        ? saved
        : transitionSession(saved, 'closed', Date.now(), saved.exitCode, 'Terminal is no longer open');
      this.sessions.set(session.id, session);
      if (terminal) {
        this.attachTerminal(session.id, terminal);
      }
    }

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const id = this.sessionIdsByTerminal.get(event.terminal);
        if (id) {
          this.updateSession(id, 'running', undefined, 'Agent command is running');
        }
      }),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const id = this.sessionIdsByTerminal.get(event.terminal);
        if (!id) {
          return;
        }
        const exitCode = event.exitCode;
        const failed = exitCode !== undefined && exitCode !== 0;
        this.updateSession(
          id,
          failed ? 'failed' : 'completed',
          exitCode,
          failed ? `Agent exited with code ${exitCode}` : 'Agent command finished'
        );
        if (
          vscode.workspace.getConfiguration('multiTerm').get('notifyOnAgentExit', true) &&
          vscode.window.activeTerminal !== event.terminal
        ) {
          const session = this.sessions.get(id);
          if (session) {
            void vscode.window.showInformationMessage(
              `${session.label}: ${failed ? 'agent failed' : 'agent finished'}`,
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
        this.sessionIdsByTerminal.delete(terminal);
        this.updateSession(id, 'closed', terminal.exitStatus?.code, 'Terminal closed');
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) {
          return;
        }
        const id = this.sessionIdsByTerminal.get(terminal);
        if (id) {
          this.markRead(id);
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

  public async launch(request: LaunchRequest): Promise<AgentSession> {
    const session = createSession(
      request.kind,
      request.label,
      request.command,
      request.cwd
    );
    const parentTerminal = request.parentSessionId
      ? this.terminals.get(request.parentSessionId)
      : undefined;
    const configuredLocation = vscode.workspace
      .getConfiguration('multiTerm')
      .get<'editor' | 'panel'>('terminals.location', 'editor');
    const endpoint = this.attentionServer.endpoint;
    const helperPath = path.join(this.context.extensionPath, 'out', 'src', 'notify.js');
    const location: vscode.TerminalOptions['location'] = parentTerminal
      ? { parentTerminal }
      : configuredLocation === 'editor'
        ? { viewColumn: vscode.ViewColumn.Two, preserveFocus: false }
        : vscode.TerminalLocation.Panel;

    const launchCommand = await this.prepareLaunchCommand(request);
    const terminal = vscode.window.createTerminal({
      name: session.terminalName,
      cwd: vscode.Uri.file(request.cwd),
      location,
      iconPath: new vscode.ThemeIcon(request.kind === 'claude' ? 'sparkle' : 'terminal'),
      env: {
        MULTITERM_SESSION_ID: session.id,
        MULTITERM_NOTIFY_URL: endpoint.url,
        MULTITERM_NOTIFY_TOKEN: endpoint.token,
        MULTITERM_NOTIFY_HELPER: helperPath,
        MULTITERM_USAGE_URL: endpoint.url.replace(/\/events$/, '/usage')
      }
    });
    this.sessions.set(session.id, session);
    this.attachTerminal(session.id, terminal);
    await this.persistAndNotify();
    terminal.show(false);
    terminal.sendText(launchCommand, true);
    return session;
  }

  public async focus(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      void vscode.window.showWarningMessage('That agent terminal is no longer open.');
      return;
    }
    this.markRead(id);
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

  public async close(id: string): Promise<void> {
    this.terminals.get(id)?.dispose();
    if (!this.terminals.has(id)) {
      this.updateSession(id, 'closed', undefined, 'Terminal closed');
    }
  }

  public async restart(id: string): Promise<void> {
    const session = this.sessions.get(id);
    const terminal = this.terminals.get(id);
    if (!session || !terminal) {
      void vscode.window.showWarningMessage('Reopen the agent before restarting it.');
      return;
    }
    session.status = 'starting';
    session.unread = false;
    session.latestEvent = 'Restarting agent command';
    session.updatedAt = Date.now();
    await this.persistAndNotify();
    terminal.show(false);
    terminal.sendText(session.command, true);
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
    if (!this.sessions.has(id)) {
      return undefined;
    }
    const helperPath = path.join(this.context.extensionPath, 'out', 'src', 'notify.js');
    return `node ${shellQuote(helperPath)} attention`;
  }

  public dispose(): void {
    this.attentionServer.dispose();
    this.changedEmitter.dispose();
    this.usageEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private attachTerminal(id: string, terminal: vscode.Terminal): void {
    this.terminals.set(id, terminal);
    this.sessionIdsByTerminal.set(terminal, id);
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
    this.sessions.set(id, transitionSession(session, status, Date.now(), exitCode, message));
    void this.persistAndNotify();
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    const session = this.sessions.get(event.sessionId);
    if (!session) {
      return;
    }
    this.updateSession(
      event.sessionId,
      event.status,
      event.exitCode,
      event.message ?? defaultEventMessage(event.status)
    );
    const terminal = this.terminals.get(event.sessionId);
    if (
      event.status === 'attention' &&
      vscode.workspace.getConfiguration('multiTerm').get('notifyOnAttention', true) &&
      vscode.window.activeTerminal !== terminal
    ) {
      const choice = await vscode.window.showInformationMessage(
        `${session.label}: ${event.message ?? 'needs attention'}`,
        'Focus Agent'
      );
      if (choice) {
        await this.focus(event.sessionId);
      }
    }
  }

  private async persistAndNotify(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, this.list());
    this.changedEmitter.fire();
  }

  private async prepareLaunchCommand(request: LaunchRequest): Promise<string> {
    if (
      request.kind !== 'claude' ||
      !vscode.workspace
        .getConfiguration('multiTerm.usage.claude')
        .get('statusLineIntegration', true) ||
      /(^|\s)--settings(?:\s|=)/.test(request.command)
    ) {
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
      'claude-multiterm-settings.json'
    );
    const settings = {
      statusLine: {
        type: 'command',
        command: `node ${shellQuote(helperPath)}`
      }
    };
    await vscode.workspace.fs.writeFile(
      settingsUri,
      Buffer.from(JSON.stringify(settings), 'utf8')
    );
    return `${request.command} --settings ${shellQuote(settingsUri.fsPath)}`;
  }
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') {
    return `\"${value.replace(/\"/g, '\"\"')}\"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultEventMessage(status: AgentEvent['status']): string {
  switch (status) {
    case 'running':
      return 'Agent is running';
    case 'attention':
      return 'Agent needs attention';
    case 'completed':
      return 'Agent completed';
    case 'failed':
      return 'Agent failed';
  }
}

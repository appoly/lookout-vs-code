import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isDirectAgentCommand } from './agentCommand';
import { ReviewTreeItem, ReviewTreeProvider } from './reviewTree';
import { SessionManager } from './sessionManager';
import {
  SessionStatusBar,
  SessionTreeItem,
  SessionTreeProvider
} from './sessionTree';
import type { AgentKind, LaunchRequest } from './types';
import { UsageManager } from './usageManager';
import { UsageStatusBar, UsageTreeProvider } from './usageTree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessions = new SessionManager(context);
  context.subscriptions.push(sessions);
  await sessions.initialize();
  const sessionTree = new SessionTreeProvider(sessions);
  const sessionTreeView = vscode.window.createTreeView('lookout.sessions', {
    treeDataProvider: sessionTree
  });
  const sessionStatus = new SessionStatusBar(sessions);
  const reviewTree = new ReviewTreeProvider(sessions);
  const usage = new UsageManager(context, sessions);
  const usageTree = new UsageTreeProvider(usage);
  const usageStatus = new UsageStatusBar(usage);

  context.subscriptions.push(
    sessionTree,
    sessionTreeView,
    sessionStatus,
    reviewTree,
    usage,
    usageTree,
    usageStatus,
    vscode.window.registerTreeDataProvider('lookout.review', reviewTree),
    vscode.workspace.registerTextDocumentContentProvider(
      'lookout-baseline',
      reviewTree
    ),
    vscode.window.registerTreeDataProvider('lookout.usage', usageTree),
    register('lookout.launchAgent', () => chooseAndLaunchAgent(sessions)),
    register('lookout.launchCodex', () => launchAgent(sessions, 'codex')),
    register('lookout.launchClaude', () => launchAgent(sessions, 'claude')),
    register('lookout.launchCustom', () => launchAgent(sessions, 'custom')),
    register('lookout.launchAgentInWorktree', () =>
      launchAgentInWorktree(sessions)
    ),
    register('lookout.adoptTerminal', (terminal?: vscode.Terminal) =>
      adoptTerminal(sessions, terminal)
    ),
    register('lookout.splitCodex', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'codex', sessionId(item))
    ),
    register('lookout.splitClaude', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'claude', sessionId(item))
    ),
    register('lookout.splitSession', (item?: SessionTreeItem) =>
      splitSession(sessions, item)
    ),
    register('lookout.focusSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.focus(id) : undefined;
    }),
    register('lookout.focusNextAttention', () => sessions.focusNextAttention()),
    register('lookout.pickSession', () => pickSession(sessions)),
    register('lookout.focusNextSession', () => sessions.focusAdjacent(1)),
    register('lookout.focusPreviousSession', () => sessions.focusAdjacent(-1)),
    register('lookout.renameSession', async (item?: SessionTreeItem) => {
      const id = sessionId(item);
      if (!id) {
        return;
      }
      const session = sessions.get(id);
      if (!session) {
        return;
      }
      const label = await vscode.window.showInputBox({
        title: 'Rename Agent Session',
        value: session.label,
        validateInput: nonEmpty
      });
      if (label) {
        await sessions.rename(id, label);
      }
    }),
    register('lookout.closeSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.close(id) : undefined;
    }),
    register('lookout.restartSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.restart(id) : undefined;
    }),
    register('lookout.markNeedsAttention', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      if (id) {
        sessions.markAttention(id);
      }
    }),
    register('lookout.copyNotifyCommand', async (item?: SessionTreeItem) => {
      const id = sessionId(item);
      const command = id ? sessions.notifyCommand(id) : undefined;
      if (command) {
        await vscode.env.clipboard.writeText(command);
        void vscode.window.showInformationMessage('Agent attention hook command copied.');
      } else {
        void vscode.window.showWarningMessage(
          'This restored terminal is not connected to the current attention bridge. Launch a new session to use hooks.'
        );
      }
    }),
    register('lookout.refreshSessions', () => sessionTree.refresh()),
    register('lookout.toggleAttentionSound', async () => {
      await sessions.toggleAttentionSound();
      await updateSoundContext();
    }),
    register('lookout.muteAttentionSound', async () => {
      await sessions.setAttentionSoundEnabled(false);
      await updateSoundContext();
    }),
    register('lookout.unmuteAttentionSound', async () => {
      await sessions.setAttentionSoundEnabled(true);
      await updateSoundContext();
    }),
    register('lookout.configureAttentionSound', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'lookout.attentionSound'
      )
    ),
    register('lookout.testAttentionSound', () => sessions.testAttentionSound()),
    register('lookout.refreshReview', () => reviewTree.refresh()),
    register('lookout.refreshUsage', () => usage.refresh()),
    register('lookout.openReviewItem', (item?: ReviewTreeItem) =>
      item ? reviewTree.open(item) : undefined
    ),
    register('lookout.openSourceControl', () =>
      vscode.commands.executeCommand('workbench.view.scm')
    ),
    register('lookout.openTestExplorer', () =>
      vscode.commands.executeCommand('workbench.view.testing.focus')
    ),
    register('lookout.runTestTask', () => runTestTask()),
    register('lookout.startDebug', () =>
      vscode.commands.executeCommand('workbench.action.debug.selectandstart')
    ),
    register('lookout.openReviewLayout', () => openReviewLayout(sessions)),
    register('lookout.runTask', () => runWorkspaceTask()),
    register('lookout.openBrowser', () => openBrowser())
  );

  const updateSessionBadge = (): void => {
    const unread = sessions.list().filter((session) => session.unread).length;
    sessionTreeView.badge = unread > 0
      ? {
          value: unread,
          tooltip: `${unread} unread agent update${unread === 1 ? '' : 's'}`
        }
      : undefined;
  };
  context.subscriptions.push(
    sessions.onDidChange(updateSessionBadge),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lookout.attentionSound.enabled')) {
        void updateSoundContext();
      }
    })
  );
  updateSessionBadge();
  await updateSoundContext();

  void reviewTree.initialize();
  usage.initialize();
}

export function deactivate(): void {}

async function updateSoundContext(): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('lookout.attentionSound')
    .get('enabled', true);
  await vscode.commands.executeCommand(
    'setContext',
    'lookout.attentionSoundEnabled',
    enabled
  );
}

function register<Args extends unknown[]>(
  command: string,
  callback: (...args: Args) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(command, callback);
}

async function launchAgent(
  sessions: SessionManager,
  kind: AgentKind,
  parentSessionId?: string,
  cwdOverride?: string
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Trust this workspace before launching an agent.');
    return;
  }
  const cwd = cwdOverride ?? (await pickWorkingDirectory());
  if (!cwd) {
    return;
  }
  const command =
    kind === 'custom'
      ? await vscode.window.showInputBox({
          title: 'Agent command',
          prompt: 'Command to run in the new terminal',
          validateInput: nonEmpty
        })
      : vscode.workspace
          .getConfiguration('lookout')
          .get<string>(`${kind}.command`, kind);
  if (!command) {
    return;
  }
  if (
    kind !== 'custom' &&
    isDirectAgentCommand(command, kind) &&
    !(await executableAvailable(command))
  ) {
    const choice = await vscode.window.showErrorMessage(
      `${displayKind(kind)} could not be found. Install it or configure lookout.${kind}.command.`,
      'Open Settings'
    );
    if (choice) {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `lookout.${kind}.command`
      );
    }
    return;
  }
  const ordinal = sessions.list().filter((session) => session.kind === kind).length + 1;
  const label = `${displayKind(kind)} ${ordinal}`;
  const request: LaunchRequest = {
    kind,
    label,
    command,
    cwd,
    ...(parentSessionId ? { parentSessionId } : {})
  };
  await sessions.launch(request);
}

async function chooseAndLaunchAgent(
  sessions: SessionManager,
  cwdOverride?: string
): Promise<void> {
  const providers = [
      {
        label: 'Codex',
        description: 'OpenAI Codex CLI',
        iconPath: new vscode.ThemeIcon('terminal'),
        agentKind: 'codex' as const
      },
      {
        label: 'Claude Code',
        description: 'Anthropic Claude Code',
        iconPath: new vscode.ThemeIcon('sparkle'),
        agentKind: 'claude' as const
      },
      {
        label: 'Custom',
        description: 'Choose another terminal agent command',
        iconPath: new vscode.ThemeIcon('tools'),
        agentKind: 'custom' as const
      }
    ];
  const selected = await vscode.window.showQuickPick(
    providers.filter(
      (provider) =>
        provider.agentKind === 'custom' ||
        vscode.workspace
          .getConfiguration(`lookout.${provider.agentKind}`)
          .get('enabled', true)
    ),
    {
      title: 'New Agent',
      placeHolder: 'Choose the agent to launch'
    }
  );
  if (selected) {
    await launchAgent(sessions, selected.agentKind, undefined, cwdOverride);
  }
}

async function launchAgentInWorktree(sessions: SessionManager): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Trust this workspace before creating an agent worktree.'
    );
    return;
  }
  const source = await pickWorkingDirectory();
  if (!source) {
    return;
  }
  let repoRoot: string;
  try {
    repoRoot = (await runCommand('git', [
      '-C', source, 'rev-parse', '--show-toplevel'
    ])).trim();
  } catch {
    void vscode.window.showErrorMessage(
      'The selected folder is not inside a Git repository.'
    );
    return;
  }
  const suffix = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const branch = await vscode.window.showInputBox({
    title: 'New Agent Worktree Branch',
    value: `lookout/agent-${suffix}`,
    validateInput: nonEmpty
  });
  if (!branch) {
    return;
  }
  const target = await vscode.window.showInputBox({
    title: 'New Agent Worktree Folder',
    value: path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}-${branch.replace(/[^a-z0-9._-]+/gi, '-')}`
    ),
    validateInput: nonEmpty
  });
  if (!target) {
    return;
  }
  try {
    await runCommand('git', [
      '-C', repoRoot, 'worktree', 'add', '-b', branch, target
    ]);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not create the worktree: ${commandError(error)}`
    );
    return;
  }
  await chooseAndLaunchAgent(sessions, target);
}

async function splitSession(
  sessions: SessionManager,
  item: SessionTreeItem | undefined
): Promise<void> {
  if (!item || !vscode.workspace.isTrusted) {
    return;
  }
  const session = item.session;
  if (!session.command) {
    void vscode.window.showWarningMessage(
      'This restored custom session did not persist its command. Launch it again instead of splitting it.'
    );
    return;
  }
  await sessions.launch({
    kind: session.kind,
    label: `${session.label} split`,
    command: session.command,
    cwd: session.cwd,
    parentSessionId: session.id
  });
}

async function pickSession(sessions: SessionManager): Promise<void> {
  const candidates = sessions.list().filter((session) => sessions.isOpen(session.id));
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage('No agent terminals are open.');
    return;
  }
  const selected = await vscode.window.showQuickPick(
    candidates.map((session) => ({
      label: session.label,
      description: `${session.kind} · ${path.basename(session.cwd)}${
        session.baseline?.branch ? ` · ${session.baseline.branch}` : ''
      }`,
      detail: session.latestEvent ?? session.status,
      session
    })),
    {
      title: 'Focus Agent',
      placeHolder: 'Jump directly to an agent terminal'
    }
  );
  if (selected) {
    await sessions.focus(selected.session.id);
  }
}

async function pickWorkingDirectory(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const chooseFolder = async (defaultPath: string): Promise<string | undefined> => {
    const selected = await vscode.window.showOpenDialog({
      title: 'Choose the agent working directory',
      defaultUri: vscode.Uri.file(defaultPath),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use Folder'
    });
    return selected?.[0]?.fsPath;
  };
  if (folders.length === 0) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return chooseFolder(
      activeUri?.scheme === 'file' ? path.dirname(activeUri.fsPath) : homedir()
    );
  }
  const choice = await vscode.window.showQuickPick(
    [
      ...folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        cwd: folder.uri.fsPath
      })),
      {
        label: 'Choose another folder…',
        description: 'Launch an agent outside the open workspace',
        cwd: undefined
      }
    ],
    {
      title: 'Choose the agent working directory',
      placeHolder: 'Use a workspace root or browse to another folder'
    }
  );
  if (!choice) {
    return undefined;
  }
  return choice.cwd ?? chooseFolder(folders[0].uri.fsPath);
}

async function adoptTerminal(
  sessions: SessionManager,
  requestedTerminal?: vscode.Terminal
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Trust this workspace before adopting an agent terminal.'
    );
    return;
  }
  const candidates = vscode.window.terminals.filter(
    (terminal) => !sessions.managesTerminal(terminal)
  );
  const requestedCandidate = requestedTerminal && candidates.includes(requestedTerminal)
    ? requestedTerminal
    : undefined;
  const selected = requestedCandidate
    ? { label: requestedCandidate.name, terminal: requestedCandidate }
    : await vscode.window.showQuickPick(
        candidates.map((terminal) => ({ label: terminal.name, terminal })),
        { title: 'Adopt Existing Terminal' }
      );
  if (!selected) {
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('No unmanaged terminals are open.');
    }
    return;
  }
  const kinds = [
      { label: 'Codex', agentKind: 'codex' as const },
      { label: 'Claude Code', agentKind: 'claude' as const },
      { label: 'Custom', agentKind: 'custom' as const }
    ];
  const suggestedKind = inferAgentKind(selected.terminal.name);
  const kindChoice = await vscode.window.showQuickPick(
    suggestedKind
      ? [...kinds].sort((choice) => choice.agentKind === suggestedKind ? -1 : 1)
      : kinds,
    {
      title: 'Agent provider',
      placeHolder: suggestedKind
        ? `${displayKind(suggestedKind)} suggested from the terminal name`
        : 'Choose the agent running in this terminal'
    }
  );
  if (!kindChoice) {
    return;
  }
  const cwd = selected.terminal.shellIntegration?.cwd?.fsPath
    ?? await pickWorkingDirectory();
  if (!cwd) {
    return;
  }
  await sessions.adopt(
    selected.terminal,
    kindChoice.agentKind,
    selected.terminal.name,
    cwd
  );
}

function inferAgentKind(terminalName: string): AgentKind | undefined {
  const normalized = terminalName.toLowerCase();
  if (normalized.includes('codex')) {
    return 'codex';
  }
  if (normalized.includes('claude')) {
    return 'claude';
  }
  return undefined;
}

async function openBrowser(): Promise<void> {
  const defaultUrl = vscode.workspace
    .getConfiguration('lookout.browser')
    .get('defaultUrl', 'http://localhost:3000');
  const value = await vscode.window.showInputBox({
    title: 'Open Browser',
    value: defaultUrl,
    validateInput: (input) => {
      try {
        const url = new URL(input);
        return url.protocol === 'http:' || url.protocol === 'https:'
          ? undefined
          : 'Use an http or https URL';
      } catch {
        return 'Enter a valid URL';
      }
    }
  });
  if (!value) {
    return;
  }
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(value));
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes('workbench.action.browser.open')) {
    await vscode.commands.executeCommand(
      'workbench.action.browser.open',
      uri.toString()
    );
  } else if (commands.includes('simpleBrowser.show')) {
    await vscode.commands.executeCommand('simpleBrowser.show', uri.toString());
  } else {
    await vscode.env.openExternal(uri);
  }
}

async function runWorkspaceTask(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Trust this workspace before running tasks.'
    );
    return;
  }
  const tasks = await vscode.tasks.fetchTasks();
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage('No workspace tasks were found.');
    return;
  }
  const selected = await vscode.window.showQuickPick(
    tasks.map((task) => ({
      label: task.name,
      description: task.source,
      detail: task.detail,
      task
    })),
    {
      title: 'Run Workspace Task',
      placeHolder: 'Choose a VS Code task to run'
    }
  );
  if (selected) {
    await vscode.tasks.executeTask(selected.task);
  }
}

function sessionId(item: SessionTreeItem | undefined): string | undefined {
  return item?.session.id;
}

function displayKind(kind: AgentKind): string {
  if (kind === 'claude') {
    return 'Claude';
  }
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function nonEmpty(value: string): string | undefined {
  return value.trim() ? undefined : 'Enter a value';
}

async function runTestTask(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Trust this workspace before running test tasks.'
    );
    return;
  }
  const tasks = (await vscode.tasks.fetchTasks()).filter(
    (task) => task.group === vscode.TaskGroup.Test
  );
  if (tasks.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No VS Code test tasks were found.',
      'Open Test Explorer'
    );
    if (choice) {
      await vscode.commands.executeCommand('workbench.view.testing.focus');
    }
    return;
  }
  const selected = tasks.length === 1
    ? tasks[0]
    : (
        await vscode.window.showQuickPick(
          tasks.map((task) => ({
            label: task.name,
            description: task.source,
            task
          })),
          { title: 'Run Test Task' }
        )
      )?.task;
  if (selected) {
    await vscode.tasks.executeTask(selected);
  }
}

async function openReviewLayout(sessions: SessionManager): Promise<void> {
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: [{ size: 1 }, { size: 1 }]
  });
  const selected = sessions.selectedSession;
  if (selected && sessions.isOpen(selected.id)) {
    await sessions.focus(selected.id);
  }
  await vscode.commands.executeCommand('workbench.view.extension.lookout');
}

async function executableAvailable(command: string): Promise<boolean> {
  const token = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = token?.[1] ?? token?.[2] ?? token?.[3];
  if (!executable) {
    return false;
  }
  if (path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
    try {
      await access(executable);
      return true;
    } catch {
      return false;
    }
  }
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [executable],
      { windowsHide: true },
      (error) => resolve(!error)
    );
  });
}

function runCommand(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr).trim() || error.message));
        } else {
          resolve(String(stdout));
        }
      }
    );
  });
}

function commandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewTreeItem, ReviewTreeProvider } from './reviewTree';
import { SessionManager } from './sessionManager';
import { SessionTreeItem, SessionTreeProvider } from './sessionTree';
import type { AgentKind, LaunchRequest } from './types';
import { UsageManager } from './usageManager';
import { UsageStatusBar, UsageTreeProvider } from './usageTree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessions = new SessionManager(context);
  context.subscriptions.push(sessions);
  await sessions.initialize();
  const sessionTree = new SessionTreeProvider(sessions);
  const reviewTree = new ReviewTreeProvider(sessions);
  const usage = new UsageManager(context, sessions);
  const usageTree = new UsageTreeProvider(usage);
  const usageStatus = new UsageStatusBar(usage);

  context.subscriptions.push(
    sessionTree,
    reviewTree,
    usage,
    usageTree,
    usageStatus,
    vscode.window.registerTreeDataProvider('parful.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('parful.review', reviewTree),
    vscode.workspace.registerTextDocumentContentProvider(
      'parful-baseline',
      reviewTree
    ),
    vscode.window.registerTreeDataProvider('parful.usage', usageTree),
    register('parful.launchAgent', () => chooseAndLaunchAgent(sessions)),
    register('parful.launchCodex', () => launchAgent(sessions, 'codex')),
    register('parful.launchClaude', () => launchAgent(sessions, 'claude')),
    register('parful.launchCustom', () => launchAgent(sessions, 'custom')),
    register('parful.splitCodex', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'codex', sessionId(item))
    ),
    register('parful.splitClaude', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'claude', sessionId(item))
    ),
    register('parful.splitSession', (item?: SessionTreeItem) =>
      splitSession(sessions, item)
    ),
    register('parful.focusSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.focus(id) : undefined;
    }),
    register('parful.focusNextAttention', () => sessions.focusNextAttention()),
    register('parful.pickSession', () => pickSession(sessions)),
    register('parful.focusNextSession', () => sessions.focusAdjacent(1)),
    register('parful.focusPreviousSession', () => sessions.focusAdjacent(-1)),
    register('parful.renameSession', async (item?: SessionTreeItem) => {
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
    register('parful.closeSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.close(id) : undefined;
    }),
    register('parful.restartSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.restart(id) : undefined;
    }),
    register('parful.markNeedsAttention', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      if (id) {
        sessions.markAttention(id);
      }
    }),
    register('parful.copyNotifyCommand', async (item?: SessionTreeItem) => {
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
    register('parful.refreshSessions', () => sessionTree.refresh()),
    register('parful.toggleAttentionSound', () =>
      sessions.toggleAttentionSound()
    ),
    register('parful.refreshReview', () => reviewTree.refresh()),
    register('parful.refreshUsage', () => usage.refresh()),
    register('parful.openReviewItem', (item?: ReviewTreeItem) =>
      item ? reviewTree.open(item) : undefined
    ),
    register('parful.openSourceControl', () =>
      vscode.commands.executeCommand('workbench.view.scm')
    ),
    register('parful.runTask', () => runWorkspaceTask()),
    register('parful.openBrowser', () => openBrowser())
  );

  void reviewTree.initialize();
  usage.initialize();
}

export function deactivate(): void {}

function register(
  command: string,
  callback: (...args: never[]) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(command, callback);
}

async function launchAgent(
  sessions: SessionManager,
  kind: AgentKind,
  parentSessionId?: string
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Trust this workspace before launching an agent.');
    return;
  }
  const cwd = await pickWorkingDirectory();
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
          .getConfiguration('parful')
          .get<string>(`${kind}.command`, kind);
  if (!command) {
    return;
  }
  const ordinal = sessions.list().filter((session) => session.kind === kind).length + 1;
  const label = await vscode.window.showInputBox({
    title: `New ${displayKind(kind)} Agent`,
    prompt: 'A short task name makes parallel sessions easy to scan',
    value: `${displayKind(kind)} ${ordinal}`,
    validateInput: nonEmpty
  });
  if (!label) {
    return;
  }
  const request: LaunchRequest = {
    kind,
    label,
    command,
    cwd,
    ...(parentSessionId ? { parentSessionId } : {})
  };
  await sessions.launch(request);
}

async function chooseAndLaunchAgent(sessions: SessionManager): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    [
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
    ],
    {
      title: 'New Agent',
      placeHolder: 'Choose the agent to launch'
    }
  );
  if (selected) {
    await launchAgent(sessions, selected.agentKind);
  }
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
  if (folders.length === 0) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme === 'file') {
      return path.dirname(activeUri.fsPath);
    }
    const selected = await vscode.window.showOpenDialog({
      title: 'Choose the agent working directory',
      defaultUri: vscode.Uri.file(homedir()),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use Folder'
    });
    return selected?.[0]?.fsPath;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const choice = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    { title: 'Choose the agent working directory' }
  );
  return choice?.folder.uri.fsPath;
}

async function openBrowser(): Promise<void> {
  const defaultUrl = vscode.workspace
    .getConfiguration('parful.browser')
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

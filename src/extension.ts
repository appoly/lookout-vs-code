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
  await sessions.initialize();
  const sessionTree = new SessionTreeProvider(sessions);
  const reviewTree = new ReviewTreeProvider();
  await reviewTree.initialize();
  const usage = new UsageManager(context, sessions);
  const usageTree = new UsageTreeProvider(usage);
  const usageStatus = new UsageStatusBar(usage);

  context.subscriptions.push(
    sessions,
    sessionTree,
    reviewTree,
    usage,
    usageTree,
    usageStatus,
    vscode.window.registerTreeDataProvider('multiTerm.sessions', sessionTree),
    vscode.window.registerTreeDataProvider('multiTerm.review', reviewTree),
    vscode.window.registerTreeDataProvider('multiTerm.usage', usageTree),
    register('multiTerm.launchCodex', () => launchAgent(sessions, 'codex')),
    register('multiTerm.launchClaude', () => launchAgent(sessions, 'claude')),
    register('multiTerm.launchCustom', () => launchAgent(sessions, 'custom')),
    register('multiTerm.splitCodex', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'codex', sessionId(item))
    ),
    register('multiTerm.splitClaude', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'claude', sessionId(item))
    ),
    register('multiTerm.focusSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.focus(id) : undefined;
    }),
    register('multiTerm.focusNextAttention', () => sessions.focusNextAttention()),
    register('multiTerm.renameSession', async (item?: SessionTreeItem) => {
      const id = sessionId(item);
      const session = id ? sessions.get(id) : undefined;
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
    register('multiTerm.closeSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.close(id) : undefined;
    }),
    register('multiTerm.restartSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.restart(id) : undefined;
    }),
    register('multiTerm.markNeedsAttention', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      if (id) {
        sessions.markAttention(id);
      }
    }),
    register('multiTerm.copyNotifyCommand', async (item?: SessionTreeItem) => {
      const id = sessionId(item);
      const command = id ? sessions.notifyCommand(id) : undefined;
      if (command) {
        await vscode.env.clipboard.writeText(command);
        void vscode.window.showInformationMessage('Agent attention hook command copied.');
      }
    }),
    register('multiTerm.refreshSessions', () => sessionTree.refresh()),
    register('multiTerm.refreshReview', () => reviewTree.refresh()),
    register('multiTerm.refreshUsage', () => usage.refresh()),
    register('multiTerm.openReviewItem', (item?: ReviewTreeItem) => openReviewItem(item)),
    register('multiTerm.openSourceControl', () =>
      vscode.commands.executeCommand('workbench.view.scm')
    ),
    register('multiTerm.openBrowser', () => openBrowser())
  );

  await usage.initialize();
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
          .getConfiguration('multiTerm')
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

async function pickWorkingDirectory(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return vscode.env.appRoot;
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

async function openReviewItem(item?: ReviewTreeItem): Promise<void> {
  if (!item?.uri) {
    return;
  }
  await vscode.commands.executeCommand('vscode.open', item.uri, {
    viewColumn: vscode.ViewColumn.One,
    preview: true
  });
}

async function openBrowser(): Promise<void> {
  const defaultUrl = vscode.workspace
    .getConfiguration('multiTerm.browser')
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
  if (commands.includes('simpleBrowser.show')) {
    await vscode.commands.executeCommand('simpleBrowser.show', uri.toString());
  } else {
    await vscode.env.openExternal(uri);
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

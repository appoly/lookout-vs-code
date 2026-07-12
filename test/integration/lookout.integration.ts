/// <reference types="mocha" />

import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LookoutExtensionTestApi } from '../../src/extension';
import type { AgentEvent, AgentSession } from '../../src/types';

const EXTENSION_ID = 'adamh.lookout';
const SESSION_PREFIX = 'Lookout: Integration Agent';

suite('Lookout extension-host integration', () => {
  let api: LookoutExtensionTestApi;
  let workspaceRoot: string;
  let session: AgentSession;
  let terminal: vscode.Terminal;

  suiteSetup(async () => {
    workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(workspaceRoot, 'The integration fixture workspace was not opened');

    const extension = vscode.extensions.getExtension<
      LookoutExtensionTestApi | undefined
    >(
      EXTENSION_ID
    );
    assert.ok(extension, `${EXTENSION_ID} was not discovered`);
    const activatedApi = await extension.activate();
    assert.ok(activatedApi, 'The extension test API was not enabled');
    api = activatedApi;

    session = await api.sessions.launch({
      kind: 'custom',
      label: 'Integration Agent',
      command: 'echo lookout-integration',
      cwd: workspaceRoot
    });
    terminal = await waitForValue(
      () =>
        vscode.window.terminals.find(
          (candidate) => terminalEnvironment(candidate).LOOKOUT_SESSION_ID === session.id
        ),
      'Lookout did not create the integration terminal'
    );
  });

  suiteTeardown(async () => {
    for (const candidate of [...vscode.window.terminals]) {
      candidate.dispose();
    }
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(workspaceRoot, 'src', 'review-target.ts')),
      Buffer.from("export const value = 'baseline';\n")
    );
  });

  test('activates and registers the core commands', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.equal(extension?.isActive, true);

    const commands = new Set(await vscode.commands.getCommands(true));
    const contributedCommands = (
      extension?.packageJSON.contributes?.commands as
        | Array<{ command?: unknown }>
        | undefined
    )
      ?.map((entry) => entry.command)
      .filter((command): command is string => typeof command === 'string') ?? [];
    assert.ok(contributedCommands.length > 0, 'No commands were contributed');
    for (const command of contributedCommands) {
      assert.ok(commands.has(command), `${command} was not registered`);
    }
  });

  test('launches a native terminal with a Git baseline and authenticated bridge', () => {
    assert.equal(normalizeFsPath(session.baseline?.repoRoot ?? ''), normalizeFsPath(workspaceRoot));
    assert.equal(session.bridgeAvailable, true);
    assert.match(terminal.name, new RegExp(`^${SESSION_PREFIX}`));

    const environment = terminalEnvironment(terminal);
    assert.equal(environment.LOOKOUT_SESSION_ID, session.id);
    assert.match(String(environment.LOOKOUT_NOTIFY_URL), /^http:\/\/127\.0\.0\.1:/);
    assert.ok(environment.LOOKOUT_NOTIFY_TOKEN);

    const options = terminal.creationOptions;
    assert.ok('location' in options);
    assert.equal(options.location, vscode.TerminalLocation.Panel);
  });

  test('routes explicit lifecycle attention and focuses the exact unread agent', async () => {
    const observer = vscode.window.createTerminal({
      name: 'Lookout Integration Observer',
      location: vscode.TerminalLocation.Panel
    });
    observer.show(false);
    await waitFor(
      () => vscode.window.activeTerminal === observer,
      'The observer terminal did not become active'
    );

    await postAgentEvent(terminal, {
      kind: 'status',
      sessionId: session.id,
      status: 'attention',
      message: 'Integration agent needs attention'
    });
    await waitFor(
      () => api.sessions.get(session.id)?.status === 'attention',
      'The attention event was not applied'
    );
    assert.equal(api.sessions.get(session.id)?.unread, true);

    const row = api.sessionTree
      .getChildren()
      .find((item) => item.session.id === session.id);
    assert.equal(row?.session.latestEvent, 'Integration agent needs attention');

    await vscode.commands.executeCommand('lookout.focusNextAttention');
    await waitFor(
      () => vscode.window.activeTerminal === terminal,
      'Attention navigation did not focus the agent terminal'
    );
    assert.equal(api.sessions.get(session.id)?.unread, false);
    observer.dispose();
  });

  test('requests a native sibling split relative to its parent', async () => {
    const splitSession = await api.sessions.launch({
      kind: 'custom',
      label: 'Integration Agent split',
      command: 'echo lookout-integration-split',
      cwd: workspaceRoot,
      parentSessionId: session.id
    });
    const splitTerminal = await waitForValue(
      () =>
        vscode.window.terminals.find(
          (candidate) =>
            terminalEnvironment(candidate).LOOKOUT_SESSION_ID === splitSession.id
        ),
      'Lookout did not create the split terminal'
    );
    const options = splitTerminal.creationOptions;
    assert.ok('location' in options);
    assert.ok(
      typeof options.location === 'object' &&
        'parentTerminal' in options.location &&
        options.location.parentTerminal === terminal,
      'The split was not requested relative to its parent terminal'
    );

    splitTerminal.dispose();
    await waitFor(
      () => api.sessions.get(splitSession.id)?.status === 'closed',
      'The split session did not observe its terminal closing'
    );
    await api.sessions.close(splitSession.id);
  });

  test('discovers a post-launch change and serves its captured baseline', async () => {
    const target = vscode.Uri.file(
      path.join(workspaceRoot, 'src', 'review-target.ts')
    );
    await vscode.workspace.fs.writeFile(
      target,
      Buffer.from("export const value = 'changed';\n")
    );
    await waitForAsyncValue(async () => {
      await api.reviewTree.refresh();
      const changesGroup = api.reviewTree
        .getChildren()
        .find((item) => item.group === 'changes');
      if (!changesGroup) {
        return undefined;
      }
      const worktree = api.reviewTree
        .getChildren(changesGroup)
        .find((item) => item.kind === 'worktree');
      return worktree
        ? api.reviewTree
            .getChildren(worktree)
            .find((item) => item.change?.path === 'src/review-target.ts')
        : undefined;
    }, 'The changed fixture file was not listed');

    const baseline = await api.reviewTree.provideTextDocumentContent(
      vscode.Uri.from({
        scheme: 'lookout-baseline',
        authority: session.id,
        path: '/src/review-target.ts'
      })
    );
    assert.equal(baseline, "export const value = 'baseline';\n");
  });

  test('marks a manually closed terminal as closed and removes its session', async () => {
    terminal.dispose();
    await waitFor(
      () => api.sessions.get(session.id)?.status === 'closed',
      'The session did not observe its terminal closing'
    );
    assert.equal(api.sessions.isOpen(session.id), false);

    await api.sessions.close(session.id);
    assert.equal(api.sessions.get(session.id), undefined);
  });
});

async function postAgentEvent(
  terminal: vscode.Terminal,
  event: AgentEvent
): Promise<void> {
  const environment = terminalEnvironment(terminal);
  const response = await fetch(String(environment.LOOKOUT_NOTIFY_URL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${String(environment.LOOKOUT_NOTIFY_TOKEN)}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(event)
  });
  assert.equal(response.status, 204);
}

function terminalEnvironment(
  terminal: vscode.Terminal
): Record<string, string | null | undefined> {
  const options = terminal.creationOptions;
  return 'env' in options ? options.env ?? {} : {};
}

function normalizeFsPath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  await waitForValue(() => (predicate() ? true : undefined), message, timeoutMs);
}

async function waitForValue<T>(
  read: () => T | undefined,
  message: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  assert.notEqual(value, undefined, message);
  return value as T;
}

async function waitForAsyncValue<T>(
  read: () => Promise<T | undefined>,
  message: string,
  timeoutMs = 5_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  assert.notEqual(value, undefined, message);
  return value as T;
}

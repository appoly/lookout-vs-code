/// <reference types="mocha" />

import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  focusNextAttentionAcrossWindows,
  type LookoutExtensionTestApi
} from '../../src/extension';
import type { CoordinationService } from '../../src/coordinationService';
import {
  COORDINATION_PROTOCOL_VERSION,
  type CoordinatedSession,
  type CoordinatedWindow
} from '../../src/coordinationModel';
import {
  LiveSessionTreeItem,
  SessionGroupItem,
  SessionTreeItem,
  SessionTreeProvider
} from '../../src/sessionTree';
import type { SessionManager } from '../../src/sessionManager';
import type { AgentEvent, AgentSession } from '../../src/types';

const EXTENSION_ID = 'appoly.lookout';
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

  test('runs the privacy-safe Doctor through the registered command', async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand('lookout.runDoctor'))
    );
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

  test('shows MCP calls with a distinct Agents icon', async () => {
    await postAgentEvent(terminal, {
      kind: 'status',
      sessionId: session.id,
      status: 'running',
      message: 'Agent is working'
    });
    await postAgentEvent(terminal, {
      kind: 'command-start',
      sessionId: session.id,
      commandId: 'mcp-integration-1',
      command: 'codex_apps.github.fetch_pr',
      activityKind: 'mcp'
    });
    await waitFor(
      () => api.sessions.get(session.id)?.runningCommands.length === 1,
      'The MCP call was not tracked as active'
    );
    const row = api.sessionTree
      .getChildren(new SessionGroupItem('current', 'Current Workspace', 1))
      .find(
        (item): item is SessionTreeItem =>
          item instanceof SessionTreeItem && item.session.id === session.id
      );
    assert.equal((row?.iconPath as vscode.ThemeIcon | undefined)?.id, 'extensions');

    await postAgentEvent(terminal, {
      kind: 'command-stop',
      sessionId: session.id,
      commandId: 'mcp-integration-1',
      command: 'codex_apps.github.fetch_pr',
      activityKind: 'mcp'
    });
    await waitFor(
      () => api.sessions.get(session.id)?.runningCommands.length === 0,
      'The completed MCP call remained active'
    );
  });

  test('projects current metadata into host-local global history', async () => {
    const record = await waitForValue(
      () => api.globalHistory
        .list()
        .find((candidate) => candidate.sourceSessionId === session.id),
      'The session was not projected into cross-project history'
    );
    assert.equal(record.workspace.key, api.globalHistory.workspace?.key);
    assert.equal(record.kind, 'custom');
    assert.equal(record.provider, undefined);
    assert.doesNotMatch(JSON.stringify(record), /lookout-integration/);
    assert.equal(api.coordination.health().state, 'disabled');
  });

  test('starts and stops the authenticated execution-host coordinator', async () => {
    const configuration = vscode.workspace.getConfiguration('lookout.experimental');
    await configuration.update(
      'crossWindowCoordination',
      true,
      vscode.ConfigurationTarget.Global
    );
    await waitFor(
      () => api.coordination.health().state === 'healthy-owner',
      `Coordinator did not become healthy: ${api.coordination.health().detail}`
    );
    assert.deepEqual(api.coordination.windows(), []);
    await configuration.update(
      'crossWindowCoordination',
      false,
      vscode.ConfigurationTarget.Global
    );
    await waitFor(
      () => api.coordination.health().state === 'disabled',
      'Coordinator did not stop after its setting was disabled'
    );
  });

  test('shows and sorts remote Agents attention only while it is unread', () => {
    const remoteWindow = coordinatedWindow([
      coordinatedSession('read-attention', 'attention', false, 400),
      coordinatedSession('unread-update', 'idle', true, 100),
      coordinatedSession('unread-attention', 'attention', true, 50),
      coordinatedSession('read-running', 'running', false, 500)
    ]);
    const readAttention = new LiveSessionTreeItem(
      remoteWindow,
      remoteWindow.sessions[0]
    );
    const unreadAttention = new LiveSessionTreeItem(
      remoteWindow,
      remoteWindow.sessions[2]
    );
    assert.equal((readAttention.iconPath as vscode.ThemeIcon).id, 'broadcast');
    assert.equal((unreadAttention.iconPath as vscode.ThemeIcon).id, 'bell-dot');

    const noopEvent = (
      () => new vscode.Disposable(() => undefined)
    ) as vscode.Event<void>;
    const provider = new SessionTreeProvider(
      {
        onDidChange: noopEvent,
        list: () => [],
        eventsFor: () => []
      } as unknown as SessionManager,
      {
        onDidChange: noopEvent,
        windows: () => [remoteWindow],
        health: () => ({ state: 'healthy-client', detail: 'test' }),
        workspace: undefined
      } as unknown as CoordinationService,
      {
        get: () => undefined,
        update: () => Promise.resolve(),
        keys: () => []
      } as vscode.Memento
    );
    try {
      const groups = provider
        .getChildren()
        .filter((item): item is SessionGroupItem => item instanceof SessionGroupItem);
      assert.deepEqual(groups.map((item) => item.group), ['current', 'live']);
      const live = provider
        .getChildren(new SessionGroupItem('live', 'Live in Other Windows', 4))
        .filter((item): item is LiveSessionTreeItem =>
          item instanceof LiveSessionTreeItem
        );
      assert.deepEqual(
        live.map((item) => item.coordinatedSession.sessionId),
        [
          'unread-attention',
          'unread-update',
          'read-running',
          'read-attention'
        ]
      );
    } finally {
      provider.dispose();
    }
  });

  test('prioritizes unread attention across windows, then local unread updates', async () => {
    const localSessions = [
      { id: 'read-local-attention', status: 'attention', unread: false },
      { id: 'unread-local-update', status: 'completed', unread: true }
    ] as unknown as readonly AgentSession[];
    let focusedLocal: string | undefined;
    let focusedRemote: string | undefined;
    const sessions = {
      list: () => localSessions,
      isOpen: () => true,
      focus: async (id: string) => {
        focusedLocal = id;
      }
    } as unknown as SessionManager;
    let remoteWindow = coordinatedWindow([
      coordinatedSession('unread-remote-attention', 'attention', true, 100)
    ]);
    const coordination = {
      windows: () => [remoteWindow],
      focusRemote: async (_windowId: string, sessionId: string) => {
        focusedRemote = sessionId;
        return true;
      }
    } as unknown as CoordinationService;

    await focusNextAttentionAcrossWindows(sessions, coordination);
    assert.equal(focusedRemote, 'unread-remote-attention');
    assert.equal(focusedLocal, undefined);

    focusedRemote = undefined;
    remoteWindow = coordinatedWindow([
      coordinatedSession('unread-remote-update', 'completed', true, 200)
    ]);
    await focusNextAttentionAcrossWindows(sessions, coordination);
    assert.equal(focusedLocal, 'unread-local-update');
    assert.equal(focusedRemote, undefined);
  });

  test('routes attention and skips a read attention state during navigation', async () => {
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
      .getChildren(new SessionGroupItem('current', 'Current Workspace', 1))
      .find(
        (item): item is SessionTreeItem =>
          item instanceof SessionTreeItem && item.session.id === session.id
      );
    assert.equal(row?.session.latestEvent, 'Integration agent needs attention');

    await vscode.commands.executeCommand('lookout.focusNextAttention');
    await waitFor(
      () => vscode.window.activeTerminal === terminal,
      'Attention navigation did not focus the agent terminal'
    );
    assert.equal(api.sessions.get(session.id)?.unread, false);
    const focusedRow = api.sessionTree
      .getChildren(new SessionGroupItem('current', 'Current Workspace', 1))
      .find(
        (item): item is SessionTreeItem =>
          item instanceof SessionTreeItem && item.session.id === session.id
      );
    assert.equal(
      (focusedRow?.iconPath as vscode.ThemeIcon | undefined)?.id,
      'question',
      'Reading an attention notification should clear its bell icon'
    );

    const unreadSession = await api.sessions.launch({
      kind: 'custom',
      label: 'Unread Integration Agent',
      command: 'echo lookout-unread-integration',
      cwd: workspaceRoot
    });
    const unreadTerminal = await waitForValue(
      () => vscode.window.terminals.find(
        (candidate) =>
          terminalEnvironment(candidate).LOOKOUT_SESSION_ID === unreadSession.id
      ),
      'Lookout did not create the unread integration terminal'
    );
    observer.show(false);
    await waitFor(
      () => vscode.window.activeTerminal === observer,
      'The observer terminal did not become active before unread navigation'
    );
    await postAgentEvent(unreadTerminal, {
      kind: 'status',
      sessionId: unreadSession.id,
      status: 'completed',
      message: 'Unread integration update'
    });
    await waitFor(
      () => api.sessions.get(unreadSession.id)?.unread === true,
      'The fallback agent update did not become unread'
    );
    await vscode.commands.executeCommand('lookout.focusNextAttention');
    await waitFor(
      () => vscode.window.activeTerminal === unreadTerminal,
      'Cross-window attention navigation preferred a read attention state'
    );

    observer.show(false);
    await waitFor(
      () => vscode.window.activeTerminal === observer,
      'The observer terminal did not become active before session navigation'
    );
    await postAgentEvent(unreadTerminal, {
      kind: 'status',
      sessionId: unreadSession.id,
      status: 'completed',
      message: 'Another unread integration update'
    });
    await waitFor(
      () => api.sessions.get(unreadSession.id)?.unread === true,
      'The second fallback agent update did not become unread'
    );
    await api.sessions.focusNextAttention();
    await waitFor(
      () => vscode.window.activeTerminal === unreadTerminal,
      'Session navigation preferred a read attention state'
    );
    unreadTerminal.dispose();
    await waitFor(
      () => api.sessions.get(unreadSession.id)?.status === 'closed',
      'The unread integration terminal did not close'
    );
    await api.sessions.close(unreadSession.id);
    observer.dispose();
  });

  test('binds provider identity separately from the Lookout session ID', async () => {
    const managed = await api.sessions.launch({
      kind: 'codex',
      label: 'Provider Identity',
      command: 'echo provider-identity',
      cwd: workspaceRoot
    });
    const managedTerminal = await waitForValue(
      () =>
        vscode.window.terminals.find(
          (candidate) =>
            terminalEnvironment(candidate).LOOKOUT_SESSION_ID === managed.id
        ),
      'Lookout did not create the provider identity terminal'
    );

    await postAgentEvent(managedTerminal, {
      kind: 'provider-session',
      sessionId: managed.id,
      provider: 'codex',
      providerSessionId: 'codex-provider-session-1',
      providerSessionSource: 'startup'
    });
    await waitFor(
      () =>
        api.sessions.get(managed.id)?.providerSessions.at(-1)?.id ===
        'codex-provider-session-1',
      'The provider session identity was not bound'
    );
    const updated = api.sessions.get(managed.id);
    assert.equal(updated?.id, managed.id);
    assert.equal(updated?.integration.lifecycle, 'healthy');
    assert.ok(
      api.sessions
        .eventsFor(managed.id)
        .some((event) => event.kind === 'identity-observed')
    );

    managedTerminal.dispose();
    await waitFor(
      () => api.sessions.get(managed.id)?.status === 'closed',
      'The provider identity terminal did not close'
    );
    await api.sessions.close(managed.id);
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
      if (!worktree) {
        return undefined;
      }
      const children = api.reviewTree.getChildren(worktree);
      const evidence = children.filter((item) => item.kind === 'evidence');
      if (!evidence.some((item) => item.label === 'Diff evidence')) {
        return undefined;
      }
      assert.deepEqual(evidence.map((item) => item.label), ['Diff evidence']);
      return children.find(
        (item) => item.change?.path === 'src/review-target.ts'
      );
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

function coordinatedWindow(
  sessions: readonly CoordinatedSession[]
): CoordinatedWindow {
  return {
    protocolVersion: COORDINATION_PROTOCOL_VERSION,
    windowId: 'remote-window',
    workspaceKey: 'remote-workspace',
    workspaceLabel: 'Remote Workspace',
    hostKind: 'local',
    observedAt: 1_000,
    sessions,
    leaseExpiresAt: 10_000
  };
}

function coordinatedSession(
  sessionId: string,
  status: CoordinatedSession['status'],
  unread: boolean,
  updatedAt: number
): CoordinatedSession {
  return {
    sessionId,
    label: sessionId,
    kind: 'custom',
    status,
    unread,
    updatedAt
  };
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

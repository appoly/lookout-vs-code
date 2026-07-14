/// <reference types="mocha" />

import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CoordinationService } from '../../src/coordinationService';
import {
  COORDINATION_PROTOCOL_VERSION,
  type CoordinatedSession,
  type CoordinatedWindow
} from '../../src/coordinationModel';
import { focusNextAttentionAcrossWindows } from '../../src/extension';
import type { GlobalHistoryService } from '../../src/globalHistoryStore';
import {
  HistoryGroupItem,
  HistoryTreeProvider,
  LiveHistoryTreeItem
} from '../../src/historyTree';
import { SessionManager } from '../../src/sessionManager';
import type { AgentSession } from '../../src/types';

suite('Lookout read-state integration', () => {
  test('remote rows show and sort attention only while it is unread', () => {
    const remoteWindow = coordinatedWindow([
      coordinatedSession('read-attention', 'attention', false, 400),
      coordinatedSession('unread-update', 'idle', true, 100),
      coordinatedSession('unread-attention', 'attention', true, 50),
      coordinatedSession('read-running', 'running', false, 500)
    ]);
    const readAttention = new LiveHistoryTreeItem(
      remoteWindow,
      remoteWindow.sessions[0]
    );
    const unreadAttention = new LiveHistoryTreeItem(
      remoteWindow,
      remoteWindow.sessions[2]
    );
    assert.equal((readAttention.iconPath as vscode.ThemeIcon).id, 'broadcast');
    assert.equal((unreadAttention.iconPath as vscode.ThemeIcon).id, 'bell-dot');

    const provider = historyProvider(remoteWindow);
    try {
      const live = provider
        .getChildren(new HistoryGroupItem('live', 'Live in Other Windows', 4))
        .filter((item): item is LiveHistoryTreeItem =>
          item instanceof LiveHistoryTreeItem
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

  test('cross-window navigation prioritizes unread attention, then local unread', async () => {
    const localSessions = agentSessions([
      { id: 'read-local-attention', status: 'attention', unread: false },
      { id: 'unread-local-update', status: 'completed', unread: true }
    ]);
    let focusedLocal: string | undefined;
    let focusedRemote: string | undefined;
    const manager = navigationManager(localSessions, (id) => {
      focusedLocal = id;
    });
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

    await focusNextAttentionAcrossWindows(manager, coordination);
    assert.equal(focusedRemote, 'unread-remote-attention');
    assert.equal(focusedLocal, undefined);

    focusedRemote = undefined;
    remoteWindow = coordinatedWindow([
      coordinatedSession('unread-remote-update', 'completed', true, 200)
    ]);
    await focusNextAttentionAcrossWindows(manager, coordination);
    assert.equal(focusedLocal, 'unread-local-update');
    assert.equal(focusedRemote, undefined);
  });

  test('local navigation skips read attention before falling back to unread', async () => {
    let focused: string | undefined;
    const manager = navigationManager(
      agentSessions([
        { id: 'read-attention', status: 'attention', unread: false },
        { id: 'unread-update', status: 'completed', unread: true }
      ]),
      (id) => {
        focused = id;
      }
    );

    await SessionManager.prototype.focusNextAttention.call(manager);
    assert.equal(focused, 'unread-update');
  });
});

const noopEvent = (
  () => new vscode.Disposable(() => undefined)
) as vscode.Event<void>;

function historyProvider(remoteWindow: CoordinatedWindow): HistoryTreeProvider {
  return new HistoryTreeProvider(
    {
      onDidChange: noopEvent,
      history: () => [],
      eventsFor: () => [],
      isOpen: () => false
    } as unknown as SessionManager,
    {
      onDidChange: noopEvent,
      list: () => [],
      isCurrentWorkspace: () => false
    } as unknown as GlobalHistoryService,
    {
      onDidChange: noopEvent,
      windows: () => [remoteWindow],
      health: () => ({ state: 'healthy-client', detail: 'test' }),
      workspace: undefined
    } as unknown as CoordinationService
  );
}

function navigationManager(
  sessions: readonly AgentSession[],
  onFocus: (id: string) => void
): SessionManager {
  return {
    list: () => sessions,
    isOpen: () => true,
    focus: async (id: string) => onFocus(id)
  } as unknown as SessionManager;
}

function agentSessions(
  sessions: ReadonlyArray<
    Pick<AgentSession, 'id' | 'status' | 'unread'>
  >
): readonly AgentSession[] {
  return sessions as unknown as readonly AgentSession[];
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

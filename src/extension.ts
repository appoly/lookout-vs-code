import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isDirectAgentCommand } from './agentCommand';
import {
  executableAvailable,
  hostPathHasExecutable
} from './executableResolver';
import { ReviewTreeItem, ReviewTreeProvider } from './reviewTree';
import { SessionManager } from './sessionManager';
import {
  LiveSessionTreeItem,
  SessionStatusBar,
  SessionTreeItem,
  SessionTreeProvider
} from './sessionTree';
import type { AgentKind, LaunchRequest, SessionStatus } from './types';
import { UsageManager } from './usageManager';
import { UsageStatusBar, UsageTreeProvider } from './usageTree';
import { GlobalHistoryTreeItem } from './historyTree';
import {
  buildProfileCatalog,
  type AgentProfile
} from './profiles/profileCatalog';
import { TemplateManager } from './templateManager';
import { buildTemplateLaunchRequest } from './templates/templateLaunch';
import type {
  SessionTemplateDraft,
  TemplateFolderPolicy
} from './templates/templateModel';
import { evaluateHealth } from './health';
import type {
  BaselineHealthState,
  BridgeState,
  LifecycleState,
  ProfileState,
  ProviderIdentityState,
  RemoteKind,
  UsageHealthState
} from './health';
import type { HealthReport } from './health';
import { formatDoctorReport } from './doctor';
import {
  createSupportBundle,
  serializeSupportBundle
} from './supportBundle';
import {
  GlobalHistoryService,
  GlobalHistoryStore
} from './globalHistoryStore';
import type {
  GlobalHistoryIntent,
  GlobalHistoryRecord
} from './globalHistoryModel';
import { currentWorkspaceIdentity } from './workspaceIdentity';
import { CoordinationService } from './coordinationService';
import { runtimeErrorIdentity } from './runtimeError';

let runtimeLog: vscode.LogOutputChannel | undefined;

export interface LookoutExtensionTestApi {
  readonly sessions: SessionManager;
  readonly sessionTree: SessionTreeProvider;
  readonly reviewTree: ReviewTreeProvider;
  readonly globalHistory: GlobalHistoryService;
  readonly coordination: CoordinationService;
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<LookoutExtensionTestApi | undefined> {
  const sessions = new SessionManager(context);
  context.subscriptions.push(sessions);
  await sessions.initialize();
  const sessionStatus = new SessionStatusBar(sessions);
  runtimeLog = vscode.window.createOutputChannel('Lookout', { log: true });
  const reviewTree = new ReviewTreeProvider(
    sessions,
    context.workspaceState,
    reportBackgroundError
  );
  const reviewTreeView = vscode.window.createTreeView('lookout.review', {
    treeDataProvider: reviewTree
  });
  reviewTree.setVisible(reviewTreeView.visible);
  const usage = new UsageManager(context, sessions);
  const usageTree = new UsageTreeProvider(usage, sessions);
  const usageStatus = new UsageStatusBar(usage);
  const workspaceIdentity = currentWorkspaceIdentity(context);
  const globalHistory = new GlobalHistoryService(
    vscode,
    new GlobalHistoryStore(context.globalStorageUri.fsPath),
    sessions,
    workspaceIdentity,
    vscode.workspace
      .getConfiguration('lookout.history')
      .get('globalEnabled', true)
  );
  const coordination = new CoordinationService(
    context,
    sessions,
    workspaceIdentity
  );
  await coordination.initialize();
  const sessionTree = new SessionTreeProvider(
    sessions,
    coordination,
    context.workspaceState
  );
  const sessionTreeView = vscode.window.createTreeView('lookout.sessions', {
    treeDataProvider: sessionTree,
    dragAndDropController: sessionTree
  });
  const globalIntentSubscription = globalHistory.onDidReceiveIntent(
    ({ intent, record }) => {
      void processPendingGlobalHistoryIntent(
        intent,
        record,
        sessions,
        coordination
      );
    }
  );
  await globalHistory.initialize();
  const templates = new TemplateManager(context.globalState);
  const doctorOutput = vscode.window.createOutputChannel('Lookout Doctor', {
    log: true
  });
  await templates.initialize();
  await updateTemplateContext(templates);

  context.subscriptions.push(
    sessionTree,
    sessionTreeView,
    sessionStatus,
    reviewTree,
    usage,
    usageTree,
    usageStatus,
    globalHistory,
    coordination,
    globalIntentSubscription,
    doctorOutput,
    runtimeLog,
    reviewTreeView,
    reviewTreeView.onDidChangeVisibility((event) =>
      reviewTree.setVisible(event.visible)
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      'lookout-baseline',
      reviewTree
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      'lookout-command-result',
      reviewTree
    ),
    vscode.window.registerTreeDataProvider('lookout.usage', usageTree),
    register('lookout.launchAgent', () => chooseAndLaunchAgent(sessions)),
    register('lookout.configureProfiles', () => configureProfiles()),
    register('lookout.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:appoly.lookout'
      )
    ),
    register('lookout.runDoctor', () =>
      runDoctor(context, sessions, usage, coordination, globalHistory, doctorOutput)
    ),
    register('lookout.exportSupportBundle', () =>
      exportSupportBundle(context, sessions, usage, coordination, globalHistory)
    ),
    register('lookout.createTemplate', () => createSessionTemplate(templates)),
    register('lookout.launchTemplate', () =>
      launchSessionTemplate(templates, sessions)
    ),
    register('lookout.deleteTemplate', () => deleteSessionTemplate(templates)),
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
      launchAgent(sessions, 'codex', sessionId(item) ?? sessions.selectedSession?.id)
    ),
    register('lookout.splitClaude', (item?: SessionTreeItem) =>
      launchAgent(sessions, 'claude', sessionId(item) ?? sessions.selectedSession?.id)
    ),
    register('lookout.splitSession', (item?: SessionTreeItem) =>
      splitSession(sessions, item)
    ),
    register('lookout.focusSession', (item?: SessionTreeItem) => {
      const id = sessionId(item);
      return id ? sessions.focus(id) : undefined;
    }),
    register('lookout.focusNextAttention', () =>
      focusNextAttentionAcrossWindows(sessions, coordination)
    ),
    register('lookout.focusNextUnread', () => sessions.focusAdjacentUnread(1)),
    register('lookout.focusPreviousUnread', () =>
      sessions.focusAdjacentUnread(-1)
    ),
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
        title: 'Rename Agent',
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
    register('lookout.resumeSession', (item?: SessionItemLike) => {
      const id = sessionId(item);
      return id
        ? continueLocalSessionWithCoordination(
            id,
            'resume',
            sessions,
            coordination,
            globalHistory
          )
        : undefined;
    }),
    register('lookout.forkSession', (item?: SessionItemLike) => {
      const id = sessionId(item);
      return id
        ? continueLocalSessionWithCoordination(
            id,
            'fork',
            sessions,
            coordination,
            globalHistory
          )
        : undefined;
    }),
    register('lookout.openGlobalHistory', (item?: GlobalHistoryTreeItem) =>
      item ? openGlobalHistoryRecord(item.record) : undefined
    ),
    register('lookout.resumeGlobalSession', (item?: GlobalHistoryTreeItem) =>
      item
        ? continueGlobalHistoryRecord(
            item.record,
            'resume',
            sessions,
            globalHistory,
            coordination
          )
        : undefined
    ),
    register('lookout.forkGlobalSession', (item?: GlobalHistoryTreeItem) =>
      item
        ? continueGlobalHistoryRecord(
            item.record,
            'fork',
            sessions,
            globalHistory,
            coordination
          )
        : undefined
    ),
    register('lookout.deleteGlobalHistory', async (item?: GlobalHistoryTreeItem) => {
      if (!item) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete Lookout history for ${item.record.label} in ${item.record.workspace.label}? Provider history and project files are not affected.`,
        { modal: true },
        'Delete Lookout History'
      );
      if (choice === 'Delete Lookout History') {
        await globalHistory.deleteRecord(item.record.id);
      }
    }),
    register('lookout.focusRemoteSession', async (item?: LiveSessionTreeItem) => {
      if (!item) {
        return;
      }
      const accepted = await coordination.focusRemote(
        item.coordinatedWindow.windowId,
        item.coordinatedSession.sessionId
      );
      void vscode.window.showInformationMessage(
        accepted
          ? `Asked ${item.coordinatedWindow.workspaceLabel} to reveal ${item.coordinatedSession.label}.`
          : 'The owning Lookout window is no longer available.'
      );
    }),
    register('lookout.configureCrossWindowCoordination', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'lookout.experimental.crossWindowCoordination'
      )
    ),
    register('lookout.archiveSession', (item?: SessionItemLike) => {
      const id = sessionId(item);
      return id ? sessions.archiveSession(id) : undefined;
    }),
    register('lookout.unarchiveSession', (item?: SessionItemLike) => {
      const id = sessionId(item);
      return id ? sessions.unarchiveSession(id) : undefined;
    }),
    register('lookout.deleteHistory', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Delete closed and archived Lookout history? This removes only Lookout metadata and does not delete provider conversations, terminals, worktrees, files, or commits.',
        { modal: true },
        'Delete Lookout History'
      );
      if (choice === 'Delete Lookout History') {
        const [localRemoved, globalRemoved] = await Promise.all([
          sessions.deleteClosedHistory(),
          globalHistory.deleteClosedHistory()
        ]);
        const removed = Math.max(localRemoved, globalRemoved);
        void vscode.window.showInformationMessage(
          `Deleted ${removed} Lookout history entr${removed === 1 ? 'y' : 'ies'}.`
        );
      }
    }),
    register('lookout.restartSession', (item?: SessionTreeItem) => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage(
          'Trust this workspace before restarting an agent command.'
        );
        return;
      }
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
          'This terminal is not connected to the current attention bridge. Launch a new session to use hooks.'
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
    register('lookout.runVerification', (item?: ReviewTreeItem) =>
      reviewTree.runVerification(item)
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
    const localUnread = sessions.list().filter((session) => session.unread).length;
    const remoteUnread = coordination
      .windows()
      .flatMap((window) => window.sessions)
      .filter((session) => session.unread)
      .length;
    const unread = localUnread + remoteUnread;
    sessionTreeView.badge = unread > 0
      ? {
          value: unread,
          tooltip: `${unread} unread agent update${unread === 1 ? '' : 's'}${remoteUnread > 0 ? ` · ${remoteUnread} in other windows` : ''}`
        }
      : undefined;
  };
  context.subscriptions.push(
    sessions.onDidChange(updateSessionBadge),
    coordination.onDidChange(updateSessionBadge),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lookout.attentionSound.enabled')) {
        void updateSoundContext();
      }
    })
  );
  updateSessionBadge();
  await updateSoundContext();

  void reviewTree.initialize().catch((error: unknown) => {
    reportBackgroundError('review-initialize', error);
    void vscode.window.showWarningMessage(
      'Lookout Review could not initialize. Run Lookout: Run Doctor for current health information.'
    );
  });
  usage.initialize();

  return process.env.LOOKOUT_TEST === '1'
    ? { sessions, sessionTree, reviewTree, globalHistory, coordination }
    : undefined;
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

async function updateTemplateContext(templates: TemplateManager): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'lookout.hasTemplates',
    templates.list().length > 0
  );
}

function register<Args extends unknown[]>(
  command: string,
  callback: (...args: Args) => unknown
): vscode.Disposable {
  return vscode.commands.registerCommand(command, async (...args: Args) => {
    try {
      return await callback(...args);
    } catch (error) {
      reportBackgroundError(`command:${command}`, error);
      void vscode.window.showErrorMessage(
        'Lookout could not complete that command. Run Lookout: Run Doctor for current health information.'
      );
      return undefined;
    }
  });
}

function reportBackgroundError(scope: string, error: unknown): void {
  const { name, code } = runtimeErrorIdentity(error);
  runtimeLog?.error(`[${scope}] failed (${name}${code ? `:${code}` : ''})`);
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
      `${displayKind(kind)} could not be found. Install it, configure lookout.${kind}.command, or launch anyway if your terminal can run it.`,
      'Launch Anyway',
      'Open Settings'
    );
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `lookout.${kind}.command`
      );
    }
    if (choice !== 'Launch Anyway') {
      return;
    }
  }
  const request: LaunchRequest = {
    kind,
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
  const profiles = await currentProfiles();
  const selected = await vscode.window.showQuickPick(
    profiles
      .filter(
        (profile) =>
          profile.kind === 'custom' ||
        vscode.workspace
          .getConfiguration(`lookout.${profile.kind}`)
          .get('enabled', true)
      )
      .map((profile) => ({
        label: profile.displayName,
        description: profileAvailabilityLabel(profile),
        detail: profile.availability.detail,
        iconPath: new vscode.ThemeIcon(
          profile.kind === 'claude'
            ? 'sparkle'
            : profile.kind === 'codex'
              ? 'terminal'
              : 'tools'
        ),
        profile
      })),
    {
      title: 'New Agent',
      placeHolder: 'Choose a detected provider profile'
    }
  );
  if (selected) {
    // 'missing' falls through to launchAgent, whose not-found dialog offers
    // Launch Anyway — detection cannot perfectly mirror the terminal shell.
    if (
      selected.profile.availability.state === 'unconfigured' ||
      selected.profile.availability.state === 'resolver-error'
    ) {
      const choice = selected.profile.commandReference
        ? await vscode.window.showErrorMessage(
            selected.profile.availability.detail,
            'Open Settings'
          )
        : await vscode.window.showErrorMessage(
            selected.profile.availability.detail
          );
      if (choice && selected.profile.commandReference) {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          selected.profile.commandReference
        );
      }
      return;
    }
    await launchAgent(sessions, selected.profile.kind, undefined, cwdOverride);
  }
}

async function configureProfiles(): Promise<void> {
  const profiles = await currentProfiles();
  const selected = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.displayName,
      description: profileAvailabilityLabel(profile),
      detail: [
        profile.availability.detail,
        `Lifecycle: ${profile.capabilities.lifecycle.support}`,
        `Resume: ${profile.capabilities.resume.support}`,
        `Fork: ${profile.capabilities.fork.support}`
      ].join(' · '),
      profile
    })),
    {
      title: 'Agent Profiles',
      placeHolder: 'Inspect a profile or open its command setting'
    }
  );
  if (selected?.profile.commandReference) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      selected.profile.commandReference
    );
  } else if (selected) {
    void vscode.window.showInformationMessage(
      'Generic terminal agents ask for a command at launch and support the explicit Lookout attention helper.'
    );
  }
}

async function createSessionTemplate(templates: TemplateManager): Promise<void> {
  const profiles = await currentProfiles();
  const selectedProfile = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.displayName,
      description: profileAvailabilityLabel(profile),
      profile
    })),
    { title: 'Template Agent Profile' }
  );
  if (!selectedProfile) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'Template Name',
    prompt: 'A reusable mission name, such as Verify bug fix',
    validateInput: nonEmpty
  });
  if (!name) {
    return;
  }
  const folderChoice = await vscode.window.showQuickPick(
    [
      {
        label: 'Ask every time',
        description: 'Choose a working folder when the template launches',
        policy: { kind: 'prompt' } as TemplateFolderPolicy
      },
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        label: `Workspace: ${folder.name}`,
        description: folder.uri.fsPath,
        policy: {
          kind: 'workspace' as const,
          workspaceFolder: folder.name
        }
      }))
    ],
    { title: 'Template Working Folder' }
  );
  if (!folderChoice) {
    return;
  }
  const worktree = await vscode.window.showQuickPick(
    [
      {
        label: 'Shared working folder',
        description: 'Launch in the selected folder',
        value: 'shared' as const
      },
      {
        label: 'Isolated Git worktree',
        description: 'Create a branch and sibling worktree at launch',
        value: 'isolated' as const
      }
    ],
    { title: 'Template Worktree Policy' }
  );
  if (!worktree) {
    return;
  }
  const initialTask = await vscode.window.showInputBox({
    title: 'Initial Task (Optional)',
    prompt: 'Lookout stages this text in the terminal without sending it'
  });
  const browserUrl = await vscode.window.showInputBox({
    title: 'Browser URL (Optional)',
    prompt: 'An http(s) URL to open after launch'
  });
  const reviewLayout = await vscode.window.showQuickPick(
    [
      { label: 'Default layout', value: 'default' as const },
      { label: 'Open review layout', value: 'review' as const }
    ],
    { title: 'Template Review Layout' }
  );
  if (!reviewLayout) {
    return;
  }
  const idBase = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '') || 'template';
  const draft: SessionTemplateDraft = {
    id: `${idBase}-${Date.now().toString(36)}`,
    name,
    labelPattern: `${name} {counter}`,
    profileId: selectedProfile.profile.id,
    folderPolicy: folderChoice.policy,
    worktreePolicy: worktree.value,
    reviewLayout: reviewLayout.value,
    ...(initialTask?.trim() ? { initialTask: initialTask.trim() } : {}),
    ...(browserUrl?.trim() ? { browserUrl: browserUrl.trim() } : {})
  };
  try {
    await templates.create(draft);
    await updateTemplateContext(templates);
    void vscode.window.showInformationMessage(`Created template ${name}.`);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not create the template: ${commandError(error)}`
    );
  }
}

async function launchSessionTemplate(
  templates: TemplateManager,
  sessions: SessionManager
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      'Trust this workspace before launching a session template.'
    );
    return;
  }
  const available = templates.list();
  if (available.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No session templates exist yet.',
      'Create Template'
    );
    if (choice) {
      await createSessionTemplate(templates);
    }
    return;
  }
  const selected = await vscode.window.showQuickPick(
    available.map((template) => ({
      label: template.name,
      description: `${template.worktreePolicy} worktree · ${template.profileId}`,
      template
    })),
    { title: 'Launch Agent from Template' }
  );
  if (!selected) {
    return;
  }
  const profiles = await currentProfiles();
  const profile = profiles.find(
    (candidate) => candidate.id === selected.template.profileId
  );
  if (!profile) {
    void vscode.window.showErrorMessage(
      `Template profile ${selected.template.profileId} is unavailable.`
    );
    return;
  }
  if (
    profile.availability.state === 'missing' ||
    profile.availability.state === 'unconfigured' ||
    profile.availability.state === 'resolver-error'
  ) {
    void vscode.window.showErrorMessage(profile.availability.detail);
    return;
  }
  const command = await runtimeProfileCommand(profile);
  if (!command) {
    return;
  }
  const selectedFolder =
    selected.template.folderPolicy.kind === 'prompt'
      ? await pickWorkingDirectory()
      : undefined;
  const built = buildTemplateLaunchRequest(selected.template, {
    profile: {
      id: profile.id,
      kind: profile.kind,
      command,
      displayName: profile.displayName
    },
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
      name: folder.name,
      path: folder.uri.fsPath
    })),
    ...(selectedFolder ? { selectedFolder } : {}),
    counter:
      sessions.list().filter((session) => session.kind === profile.kind).length + 1
  });
  if (!built.ok) {
    void vscode.window.showErrorMessage(built.errors.join(' '));
    return;
  }
  let request = built.request.session;
  if (built.request.worktreePolicy === 'isolated') {
    const target = await createAgentWorktree(request.cwd);
    if (!target) {
      return;
    }
    request = { ...request, cwd: target };
  }
  const launched = await sessions.launch(request);
  await templates.markUsed(selected.template.id);
  if (built.request.initialTask) {
    sessions.stageText(launched.id, built.request.initialTask);
  }
  if (built.request.reviewLayout === 'review') {
    await openReviewLayout(sessions);
  }
  if (built.request.browserUrl) {
    await openUrl(built.request.browserUrl);
  }
}

async function deleteSessionTemplate(templates: TemplateManager): Promise<void> {
  const selected = await vscode.window.showQuickPick(
    templates.list().map((template) => ({
      label: template.name,
      description: template.profileId,
      template
    })),
    { title: 'Delete Session Template' }
  );
  if (!selected) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete template ${selected.template.name}?`,
    { modal: true },
    'Delete Template'
  );
  if (choice === 'Delete Template') {
    await templates.remove(selected.template.id);
    await updateTemplateContext(templates);
  }
}

async function runtimeProfileCommand(
  profile: AgentProfile
): Promise<string | undefined> {
  if (profile.kind === 'custom') {
    return vscode.window.showInputBox({
      title: 'Generic Agent Command',
      prompt: 'This runtime command is not stored in the template',
      validateInput: nonEmpty
    });
  }
  return vscode.workspace
    .getConfiguration(`lookout.${profile.kind}`)
    .get<string>('command', profile.kind);
}

async function currentProfiles(): Promise<readonly AgentProfile[]> {
  return buildProfileCatalog({
    commands: {
      codex: vscode.workspace
        .getConfiguration('lookout.codex')
        .get<string>('command', 'codex'),
      claude: vscode.workspace
        .getConfiguration('lookout.claude')
        .get<string>('command', 'claude')
    },
    resolveExecutable: async (executable) => ({
      available: await executableAvailable(executable),
      detail: `Checked ${executable} on the extension host PATH and in the default terminal shell.`
    })
  });
}

function profileAvailabilityLabel(profile: AgentProfile): string {
  switch (profile.availability.state) {
    case 'available':
      return 'Detected · lifecycle and continuity available';
    case 'not-direct':
      return 'Configured wrapper · launch only';
    case 'configuration-required':
      return 'Command chosen at launch';
    case 'missing':
      return 'Executable not found';
    case 'unconfigured':
      return 'Not configured';
    case 'resolver-error':
      return 'Detection failed';
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
  const target = await createAgentWorktree(source);
  if (target) {
    await chooseAndLaunchAgent(sessions, target);
  }
}

async function createAgentWorktree(source: string): Promise<string | undefined> {
  let repoRoot: string;
  try {
    repoRoot = (await runCommand('git', [
      '-C', source, 'rev-parse', '--show-toplevel'
    ])).trim();
  } catch {
    void vscode.window.showErrorMessage(
      'The selected folder is not inside a Git repository, or Git is not available.'
    );
    return undefined;
  }
  const suffix = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
  const branch = await vscode.window.showInputBox({
    title: 'New Agent Worktree Branch',
    value: `lookout/agent-${suffix}`,
    validateInput: nonEmpty
  });
  if (!branch) {
    return undefined;
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
    return undefined;
  }
  try {
    await runCommand('git', [
      '-C', repoRoot, 'worktree', 'add', '-b', branch, target
    ]);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not create the worktree: ${commandError(error)}`
    );
    return undefined;
  }
  return target;
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
      'This session has no stored launch command — adopted terminals and restored custom sessions do not keep one. Launch a new agent instead of splitting this one.'
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
  await openUrl(value);
}

async function openUrl(value: string): Promise<void> {
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

interface SessionItemLike {
  readonly session?: { readonly id: string };
}

function sessionId(item: SessionItemLike | undefined): string | undefined {
  return item?.session?.id;
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

export async function focusNextAttentionAcrossWindows(
  sessions: SessionManager,
  coordination: CoordinationService
): Promise<void> {
  const local = sessions
    .list()
    .filter((session) => sessions.isOpen(session.id))
    .map((session) => ({ kind: 'local' as const, session }));
  const remote = coordination
    .windows()
    .flatMap((window) =>
      window.sessions.map((session) => ({
        kind: 'remote' as const,
        window,
        session
      }))
    );
  const candidate = nextUnreadAttention([...local, ...remote]);
  if (candidate?.kind === 'local') {
    await sessions.focus(candidate.session.id);
    return;
  }
  if (candidate?.kind === 'remote') {
    const accepted = await coordination.focusRemote(
      candidate.window.windowId,
      candidate.session.sessionId
    );
    if (accepted) {
      void vscode.window.showInformationMessage(
        `Asked ${candidate.window.workspaceLabel} to reveal ${candidate.session.label}.`
      );
      return;
    }
  }
  void vscode.window.showInformationMessage(
    'No agents need attention in this or another coordinated window.'
  );
}

function nextUnreadAttention<
  T extends {
    readonly session: {
      readonly status: SessionStatus;
      readonly unread: boolean;
    };
  }
>(candidates: readonly T[]): T | undefined {
  return candidates.find(
    ({ session }) => session.status === 'attention' && session.unread
  ) ?? candidates.find(({ session }) => session.unread);
}

async function openGlobalHistoryRecord(
  record: GlobalHistoryRecord
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `Open ${record.workspace.label}? This historical row does not restore or claim the old terminal.`,
    { modal: true },
    'Open Project'
  );
  if (choice !== 'Open Project') {
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.parse(record.workspace.uri, true),
    { forceNewWindow: true }
  );
}

async function continueLocalSessionWithCoordination(
  id: string,
  operation: 'resume' | 'fork',
  sessions: SessionManager,
  coordination: CoordinationService,
  globalHistory: GlobalHistoryService
): Promise<void> {
  const session = sessions.get(id);
  const provider = session?.providerSessions.at(-1);
  if (operation === 'resume' && provider) {
    const collision = coordination.providerCollision(provider.provider, provider.id);
    if (collision) {
      const choice = await vscode.window.showWarningMessage(
        `${session?.label ?? 'This provider session'} is already live in ${collision.window.workspaceLabel}.`,
        { modal: true },
        'Focus Existing',
        'Fork Instead'
      );
      if (choice === 'Focus Existing') {
        await coordination.focusRemote(
          collision.window.windowId,
          collision.sessionId
        );
        return;
      }
      if (choice === 'Fork Instead') {
        await sessions.continueProviderSession(id, 'fork');
      }
      return;
    }
    const remotelyLiveRecord = globalHistory.list().find(
      (record) =>
        record.provider?.provider === provider.provider &&
        record.provider.id === provider.id &&
        !globalHistory.isCurrentWorkspace(record) &&
        potentiallyLiveHistoryStatus(record.status)
    );
    if (
      remotelyLiveRecord &&
      !coordination.health().state.startsWith('healthy-')
    ) {
      const choice = await vscode.window.showWarningMessage(
        `${session?.label ?? 'This provider session'} was last recorded live in ${remotelyLiveRecord.workspace.label}. Enable live coordination to confirm its owner, or fork instead.`,
        { modal: true },
        'Fork Instead',
        'Configure Coordination'
      );
      if (choice === 'Fork Instead') {
        await sessions.continueProviderSession(id, 'fork');
      } else if (choice === 'Configure Coordination') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'lookout.experimental.crossWindowCoordination'
        );
      }
      return;
    }
  }
  await sessions.continueProviderSession(id, operation);
}

async function continueGlobalHistoryRecord(
  record: GlobalHistoryRecord,
  operation: 'resume' | 'fork',
  sessions: SessionManager,
  globalHistory: GlobalHistoryService,
  coordination: CoordinationService
): Promise<void> {
  const provider = record.provider;
  if (!provider || provider.state !== 'available') {
    void vscode.window.showWarningMessage(
      'This global history row has no available provider session to continue.'
    );
    return;
  }
  if (operation === 'resume') {
    const collision = coordination.providerCollision(provider.provider, provider.id);
    if (collision) {
      const choice = await vscode.window.showWarningMessage(
        `${record.label} already appears live in ${collision.window.workspaceLabel}. Resuming would attach two terminals to one provider history.`,
        { modal: true },
        'Focus Existing',
        'Fork Instead'
      );
      if (choice === 'Focus Existing') {
        await coordination.focusRemote(
          collision.window.windowId,
          collision.sessionId
        );
        return;
      }
      if (choice === 'Fork Instead') {
        return continueGlobalHistoryRecord(
          record,
          'fork',
          sessions,
          globalHistory,
          coordination
        );
      }
      return;
    }
    if (
      potentiallyLiveHistoryStatus(record.status) &&
      !coordination.health().state.startsWith('healthy-')
    ) {
      const choice = await vscode.window.showWarningMessage(
        `${record.label} was last recorded as ${record.status}, and live coordination is not available to prove that its old terminal is gone. Lookout will not create a possible duplicate resume.`,
        { modal: true },
        'Fork Instead',
        'Open Project',
        'Configure Coordination'
      );
      if (choice === 'Fork Instead') {
        return continueGlobalHistoryRecord(
          record,
          'fork',
          sessions,
          globalHistory,
          coordination
        );
      }
      if (choice === 'Open Project') {
        await openGlobalHistoryRecord(record);
      } else if (choice === 'Configure Coordination') {
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'lookout.experimental.crossWindowCoordination'
        );
      }
      return;
    }
  }
  if (globalHistory.isCurrentWorkspace(record)) {
    const profile = (await currentProfiles()).find(
      (candidate) => candidate.kind === provider.provider
    );
    if (profile?.availability.state !== 'available') {
      void vscode.window.showWarningMessage(
        `${displayKind(provider.provider)} is not available as a direct provider command in this extension host.`
      );
      return;
    }
    await sessions.continueProviderReference(
      continuationSource(record),
      operation
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `${operation === 'resume' ? 'Resume' : 'Fork'} ${record.label} with ${displayKind(record.provider.provider)}? Lookout will open ${record.workspace.label} in a new window, revalidate trust and the provider command there, then ask for final confirmation.\n\nWorking directory: ${record.cwd}`,
    { modal: true },
    operation === 'resume' ? 'Open Project to Resume' : 'Open Project to Fork'
  );
  if (!choice) {
    return;
  }
  const created = await globalHistory.createIntent(record.id, operation);
  if (!created.intent) {
    void vscode.window.showWarningMessage(
      'Lookout could not create the short-lived continuation handoff.'
    );
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.parse(record.workspace.uri, true),
    { forceNewWindow: true }
  );
}

async function processPendingGlobalHistoryIntent(
  intent: GlobalHistoryIntent,
  record: GlobalHistoryRecord,
  sessions: SessionManager,
  coordination: CoordinationService
): Promise<void> {
  if (!record.provider) {
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      `Lookout opened ${record.workspace.label}, but Workspace Trust is required before ${intent.operation === 'resume' ? 'resuming' : 'forking'} the provider session. The historical row remains available.`
    );
    return;
  }
  const profile = (await currentProfiles()).find(
    (candidate) => candidate.kind === record.provider?.provider
  );
  if (profile?.availability.state !== 'available') {
    const choice = await vscode.window.showWarningMessage(
      `${displayKind(record.provider.provider)} is not available as a direct provider command in this extension host. The continuation was not launched.`,
      'Configure Profiles'
    );
    if (choice === 'Configure Profiles') {
      await configureProfiles();
    }
    return;
  }
  if (intent.operation === 'resume') {
    const collision = coordination.providerCollision(
      record.provider.provider,
      record.provider.id
    );
    if (collision) {
      const choice = await vscode.window.showWarningMessage(
        `${record.label} is already live in ${collision.window.workspaceLabel}.`,
        { modal: true },
        'Focus Existing',
        'Fork Instead'
      );
      if (choice === 'Focus Existing') {
        await coordination.focusRemote(
          collision.window.windowId,
          collision.sessionId
        );
        return;
      }
      if (choice !== 'Fork Instead') {
        return;
      }
      await sessions.continueProviderReference(
        continuationSource(record),
        'fork'
      );
      return;
    }
  }
  await sessions.continueProviderReference(
    continuationSource(record),
    intent.operation
  );
}

function continuationSource(
  record: GlobalHistoryRecord
): import('./sessionManager').ProviderContinuationSource {
  if (!record.provider) {
    throw new Error('Global history record has no provider reference');
  }
  return {
    kind: record.provider.provider,
    label: record.label,
    cwd: record.cwd,
    configuredCommand: vscode.workspace
      .getConfiguration(`lookout.${record.provider.provider}`)
      .get('command', record.provider.provider),
    sourceLookoutSessionId: record.sourceSessionId,
    providerSessionId: record.provider.id
  };
}

function potentiallyLiveHistoryStatus(
  status: GlobalHistoryRecord['status']
): boolean {
  return status === 'starting' || status === 'active' || status === 'running' ||
    status === 'background' || status === 'attention' || status === 'idle' ||
    status === 'unknown';
}

async function runDoctor(
  context: vscode.ExtensionContext,
  sessions: SessionManager,
  usage: UsageManager,
  coordination: CoordinationService,
  globalHistory: GlobalHistoryService,
  output: vscode.LogOutputChannel
): Promise<void> {
  const report = await collectHealth(
    sessions,
    usage,
    coordination,
    globalHistory
  );
  output.clear();
  for (const line of formatDoctorReport(report, productHeader(context))) {
    output.appendLine(line);
  }
  output.show(true);
}

async function exportSupportBundle(
  context: vscode.ExtensionContext,
  sessions: SessionManager,
  usage: UsageManager,
  coordination: CoordinationService,
  globalHistory: GlobalHistoryService
): Promise<void> {
  const destination = await vscode.window.showSaveDialog({
    title: 'Export Sanitized Lookout Support Bundle',
    filters: { JSON: ['json'] },
    saveLabel: 'Export Sanitized Bundle'
  });
  if (!destination) {
    return;
  }
  const report = await collectHealth(
    sessions,
    usage,
    coordination,
    globalHistory
  );
  const bundle = createSupportBundle({
    generatedAt: Date.now(),
    product: productHeader(context),
    health: report,
    features: {
      lifecycleCodex: vscode.workspace
        .getConfiguration('lookout.codex')
        .get('lifecycleIntegration', true),
      lifecycleClaude: vscode.workspace
        .getConfiguration('lookout.claude')
        .get('lifecycleIntegration', true),
      resultCapture: vscode.workspace
        .getConfiguration('lookout.review')
        .get('captureCommandOutput', false),
      globalHistory: globalHistory.health() === 'current',
      crossWindowCoordination:
        coordination.health().state !== 'disabled'
    },
    redaction: {
      homePaths: [homedir()],
      workspacePaths: (vscode.workspace.workspaceFolders ?? []).map(
        (folder) => folder.uri.fsPath
      )
    }
  });
  await vscode.workspace.fs.writeFile(
    destination,
    new TextEncoder().encode(serializeSupportBundle(bundle))
  );
  void vscode.window.showInformationMessage(
    'Sanitized Lookout support bundle exported.'
  );
}

async function collectHealth(
  sessions: SessionManager,
  usage: UsageManager,
  coordination: CoordinationService,
  globalHistory: GlobalHistoryService
): Promise<HealthReport> {
  const [profiles, git, node] = await Promise.all([
    currentProfiles(),
    // Baselines spawn git from the extension host, so the default terminal
    // shell's PATH cannot vouch for it; node only has to work for hooks,
    // which run inside the terminal's environment.
    hostPathHasExecutable('git'),
    executableAvailable('node')
  ]);
  const snapshots = usage.list();
  return evaluateHealth({
    observedAt: Date.now(),
    workspaceTrusted: vscode.workspace.isTrusted,
    remoteKind: currentRemoteKind(),
    git: git ? 'available' : 'missing',
    node: node ? 'available' : 'missing',
    profiles: profiles.map((profile) => ({
      kind: profile.kind === 'custom' ? 'generic' : profile.kind,
      state: profileHealthState(profile)
    })),
    sessions: sessions.list().map((session) => ({
      bridge: bridgeHealthState(session.bridgeAvailable),
      lifecycle: lifecycleHealthState(session.integration.lifecycle),
      providerIdentity: providerIdentityHealthState(session),
      baseline: baselineHealthState(session.baseline)
    })),
    usage: (['codex', 'claude'] as const).map((provider) => ({
      provider,
      state: vscode.workspace
        .getConfiguration(`lookout.usage.${provider}`)
        .get('enabled', true)
        ? usageHealthState(
            snapshots.find((snapshot) => snapshot.provider === provider)?.status
          )
        : 'disabled'
    })),
    globalHistory: globalHistory.health(),
    coordination: coordination.health().state
  });
}

function productHeader(context: vscode.ExtensionContext): {
  extensionVersion: string;
  vscodeVersion: string;
  platform: 'win32' | 'darwin' | 'linux' | 'other';
} {
  const version = (context.extension.packageJSON as { version?: unknown }).version;
  return {
    extensionVersion: typeof version === 'string' ? version : 'unknown',
    vscodeVersion: vscode.version,
    platform: process.platform === 'win32' ||
      process.platform === 'darwin' ||
      process.platform === 'linux'
      ? process.platform
      : 'other'
  };
}

function currentRemoteKind(): RemoteKind {
  const remote = vscode.env.remoteName?.toLowerCase();
  if (!remote) {
    return 'local';
  }
  if (remote.includes('wsl')) {
    return 'wsl';
  }
  if (remote.includes('ssh')) {
    return 'ssh';
  }
  if (remote.includes('container')) {
    return 'dev-container';
  }
  return 'other';
}

function profileHealthState(profile: AgentProfile): ProfileState {
  switch (profile.availability.state) {
    case 'available': return 'available';
    case 'missing': return 'missing';
    case 'unconfigured': return 'unconfigured';
    case 'not-direct': return 'not-direct';
    case 'resolver-error': return 'error';
    case 'configuration-required': return 'configuration-required';
  }
}

function bridgeHealthState(available: boolean): BridgeState {
  return available ? 'available' : 'unavailable';
}

function lifecycleHealthState(
  state: import('./types').SessionIntegration['lifecycle']
): LifecycleState {
  switch (state) {
    case 'healthy': return 'healthy';
    case 'awaiting-first-hook': return 'needs-trust';
    case 'stale': return 'degraded';
    case 'bridge-unavailable':
    case 'injection-skipped':
    case 'disabled':
      return 'unavailable';
  }
}

function providerIdentityHealthState(
  session: import('./types').AgentSession
): ProviderIdentityState {
  if (session.integration.conflict) {
    return 'conflict';
  }
  if (session.providerSessions.length > 0) {
    return 'observed';
  }
  if (session.integration.expectedProviderSessionId) {
    return 'expected';
  }
  return session.kind === 'custom' ? 'unavailable' : 'unknown';
}

function baselineHealthState(
  baseline: import('./types').GitBaseline | undefined
): BaselineHealthState {
  return baseline ? 'fresh' : 'unavailable';
}

function usageHealthState(
  status: import('./usageTypes').UsageStatus | undefined
): UsageHealthState {
  switch (status) {
    case 'available': return 'current';
    case 'stale': return 'stale';
    case 'waiting': return 'waiting';
    case 'authRequired': return 'signed-out';
    case 'unsupported': return 'unsupported';
    case 'error':
    case undefined:
      return 'unknown';
  }
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

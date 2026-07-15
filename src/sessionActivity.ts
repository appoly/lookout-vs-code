import { transitionSession } from './sessionModel';
import type {
  AgentEvent,
  AgentReportedStatus,
  AgentSession,
  BackgroundAgent,
  ForegroundState,
  RunningCommand
} from './types';
import { normalizeProviderSessionState } from './providerSessionBinding';

const MAX_RUNNING_COMMANDS = 12;

export function applyAgentEvent(
  session: AgentSession,
  event: AgentEvent,
  now = Date.now()
): AgentSession {
  switch (event.kind) {
    case 'provider-session':
      // Provider identity is bound by SessionManager before activity is
      // reduced. The identity event itself does not imply working or waiting.
      return session;
    case 'status':
      return applyStatusEvent(session, event.status, event.message, event.exitCode, now);
    case 'foreground-stop':
      return applyForegroundStop(session, event.message, event.reason, now);
    case 'background-start':
      return applyBackgroundStart(session, event.agentId, event.agentLabel, now);
    case 'background-stop':
      return applyBackgroundStop(session, event.agentId, now);
    case 'command-start':
      return applyCommandStart(
        session,
        event.commandId,
        event.command,
        event.activityKind,
        now
      );
    case 'command-stop':
      return applyCommandStop(session, event.commandId, event.command, now);
  }
}

export function normalizeSessionActivity(session: AgentSession): AgentSession {
  return normalizeProviderSessionState({
    ...session,
    backgroundAgents: Array.isArray(session.backgroundAgents)
      ? session.backgroundAgents.filter(isBackgroundAgent)
      : [],
    runningCommands: Array.isArray(session.runningCommands)
      ? session.runningCommands.filter(isRunningCommand)
      : [],
    foregroundState: isForegroundState(session.foregroundState)
      ? session.foregroundState
      : 'unknown'
  });
}

function applyStatusEvent(
  session: AgentSession,
  status: AgentReportedStatus,
  message: string | undefined,
  exitCode: number | undefined,
  now: number
): AgentSession {
  // A fresh prompt ('running') and a finished turn ('completed'/'failed') both
  // end any in-flight commands from the prior turn, so drop the stale list.
  const withForeground =
    status === 'running'
      ? { ...session, foregroundState: 'working' as const, runningCommands: [] }
      : status === 'completed' || status === 'failed'
        ? { ...session, foregroundState: 'stopped' as const, runningCommands: [] }
        : session;
  return transitionSession(
    withForeground,
    status,
    now,
    exitCode,
    message ?? defaultStatusMessage(status)
  );
}

function applyForegroundStop(
  session: AgentSession,
  message: string | undefined,
  reason: 'turn-end' | undefined,
  now: number
): AgentSession {
  // The foreground turn is over, so any commands it launched have ended too.
  // Remember WHY it stopped: when delegated agents are still running the
  // status becomes 'background' now, and the drain of the last agent must
  // land on idle for a clean turn end, not on a false "waiting for input".
  const stopped = {
    ...session,
    foregroundState: reason === 'turn-end' ? ('done' as const) : ('stopped' as const),
    runningCommands: []
  };
  if (stopped.backgroundAgents.length > 0) {
    return transitionSession(
      stopped,
      'background',
      now,
      undefined,
      backgroundMessage(stopped.backgroundAgents.length)
    );
  }
  if (reason === 'turn-end') {
    return transitionSession(
      stopped,
      'idle',
      now,
      undefined,
      message ?? 'Agent finished'
    );
  }
  return transitionSession(
    stopped,
    'attention',
    now,
    undefined,
    message ?? 'Agent is waiting for input'
  );
}

function applyBackgroundStart(
  session: AgentSession,
  agentId: string,
  agentLabel: string,
  now: number
): AgentSession {
  const backgroundAgents = upsertBackgroundAgent(
    session.backgroundAgents,
    agentId,
    agentLabel
  );
  const updated = { ...session, backgroundAgents };
  if (shouldPreserveStatus(session)) {
    return { ...updated, updatedAt: now };
  }
  return transitionSession(
    updated,
    'background',
    now,
    undefined,
    backgroundMessage(backgroundAgents.length)
  );
}

function applyBackgroundStop(
  session: AgentSession,
  agentId: string,
  now: number
): AgentSession {
  const backgroundAgents = session.backgroundAgents.filter(
    (agent) => agent.id !== agentId
  );
  const updated = { ...session, backgroundAgents };
  if (shouldPreserveStatus(session)) {
    return { ...updated, updatedAt: now };
  }
  if (backgroundAgents.length > 0) {
    return transitionSession(
      updated,
      'background',
      now,
      undefined,
      backgroundMessage(backgroundAgents.length)
    );
  }
  if (session.foregroundState === 'done') {
    return transitionSession(
      updated,
      'idle',
      now,
      undefined,
      'Agent finished'
    );
  }
  if (session.foregroundState === 'stopped') {
    return transitionSession(
      updated,
      'attention',
      now,
      undefined,
      'Agent is waiting for input'
    );
  }
  if (session.foregroundState === 'working') {
    return transitionSession(
      updated,
      'running',
      now,
      undefined,
      'Agent is working'
    );
  }
  return transitionSession(
    updated,
    'active',
    now,
    undefined,
    'Agent session active'
  );
}

function applyCommandStart(
  session: AgentSession,
  commandId: string,
  command: string,
  activityKind: RunningCommand['activityKind'],
  now: number
): AgentSession {
  const remaining = session.runningCommands.filter(
    (entry) => entry.id !== commandId
  );
  // Newest last; cap the list so a hook that never fires its stop can't grow it
  // without bound (a fresh prompt or turn end still clears it entirely).
  const runningCommands = [
    ...remaining,
    { id: commandId, command, ...(activityKind ? { activityKind } : {}) }
  ].slice(-MAX_RUNNING_COMMANDS);
  // A tool call can only run after any pending permission prompt was answered,
  // so a mid-turn attention state is over once a command starts.
  if (session.status === 'attention' && session.foregroundState === 'working') {
    return transitionSession(
      { ...session, runningCommands },
      'running',
      now,
      undefined,
      'Agent is working'
    );
  }
  return { ...session, runningCommands, updatedAt: now };
}

function applyCommandStop(
  session: AgentSession,
  commandId: string,
  command: string,
  now: number
): AgentSession {
  let removed = false;
  const runningCommands = session.runningCommands.filter((entry) => {
    if (entry.id === commandId) {
      removed = true;
      return false;
    }
    return true;
  });
  // Provider versions occasionally omit or change their tool-use ID between
  // start and stop. Fall back to the newest identical command, never clearing
  // every matching concurrent command.
  if (!removed) {
    const index = runningCommands.map((entry) => entry.command).lastIndexOf(command);
    if (index >= 0) {
      runningCommands.splice(index, 1);
      removed = true;
    }
  }
  if (!removed) {
    return session;
  }
  return { ...session, runningCommands, updatedAt: now };
}

function upsertBackgroundAgent(
  agents: readonly BackgroundAgent[],
  id: string,
  label: string
): BackgroundAgent[] {
  const remaining = agents.filter((agent) => agent.id !== id);
  return [...remaining, { id, label }];
}

function isBlockingAttention(session: AgentSession): boolean {
  return session.status === 'attention' && session.foregroundState !== 'stopped';
}

function shouldPreserveStatus(session: AgentSession): boolean {
  return (
    isBlockingAttention(session) ||
    session.status === 'completed' ||
    session.status === 'failed' ||
    session.status === 'unknown' ||
    session.status === 'closed'
  );
}

function backgroundMessage(count: number): string {
  return `${count} delegated agent${count === 1 ? '' : 's'} running`;
}

function defaultStatusMessage(status: AgentReportedStatus): string {
  switch (status) {
    case 'running':
      return 'Agent is working';
    case 'attention':
      return 'Agent needs attention';
    case 'completed':
      return 'Agent completed';
    case 'failed':
      return 'Agent failed';
  }
}

function isBackgroundAgent(value: unknown): value is BackgroundAgent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.label === 'string';
}

function isRunningCommand(value: unknown): value is RunningCommand {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.command === 'string' &&
    (record.activityKind === undefined || record.activityKind === 'mcp')
  );
}

function isForegroundState(value: unknown): value is ForegroundState {
  return (
    value === 'unknown' ||
    value === 'working' ||
    value === 'stopped' ||
    value === 'done'
  );
}

import { transitionSession } from './sessionModel';
import type {
  AgentEvent,
  AgentReportedStatus,
  AgentSession,
  BackgroundAgent,
  ForegroundState
} from './types';

export function applyAgentEvent(
  session: AgentSession,
  event: AgentEvent,
  now = Date.now()
): AgentSession {
  switch (event.kind) {
    case 'status':
      return applyStatusEvent(session, event.status, event.message, event.exitCode, now);
    case 'foreground-stop':
      return applyForegroundStop(session, event.message, event.reason, now);
    case 'background-start':
      return applyBackgroundStart(session, event.agentId, event.agentLabel, now);
    case 'background-stop':
      return applyBackgroundStop(session, event.agentId, now);
  }
}

export function normalizeSessionActivity(session: AgentSession): AgentSession {
  return {
    ...session,
    backgroundAgents: Array.isArray(session.backgroundAgents)
      ? session.backgroundAgents.filter(isBackgroundAgent)
      : [],
    foregroundState: isForegroundState(session.foregroundState)
      ? session.foregroundState
      : 'unknown'
  };
}

function applyStatusEvent(
  session: AgentSession,
  status: AgentReportedStatus,
  message: string | undefined,
  exitCode: number | undefined,
  now: number
): AgentSession {
  const withForeground =
    status === 'running'
      ? { ...session, foregroundState: 'working' as const }
      : status === 'completed' || status === 'failed'
        ? { ...session, foregroundState: 'stopped' as const }
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
  const stopped = { ...session, foregroundState: 'stopped' as const };
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

function isForegroundState(value: unknown): value is ForegroundState {
  return value === 'unknown' || value === 'working' || value === 'stopped';
}

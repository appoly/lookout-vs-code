import type { AgentKind, AgentSession, SessionStatus } from './types';

const ACTIVE_STATUSES = new Set<SessionStatus>([
  'starting',
  'active',
  'running',
  'attention'
]);

export function createSession(
  kind: AgentKind,
  label: string,
  command: string,
  cwd: string,
  now = Date.now(),
  id = createSessionId(kind, now)
): AgentSession {
  return {
    id,
    kind,
    label: label.trim(),
    command: command.trim(),
    cwd,
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    terminalName: terminalName(id, label),
    bridgeAvailable: true,
    unread: false
  };
}

export function createSessionId(kind: AgentKind, now = Date.now()): string {
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${kind}-${now.toString(36)}-${entropy}`;
}

export function terminalName(id: string, label: string): string {
  return `Paraterm: ${label.trim()} [${id}]`;
}

export function isActiveSession(session: AgentSession): boolean {
  return ACTIVE_STATUSES.has(session.status);
}

export function transitionSession(
  session: AgentSession,
  status: SessionStatus,
  now = Date.now(),
  exitCode?: number,
  latestEvent?: string
): AgentSession {
  const unread = status === 'attention' || status === 'completed' || status === 'failed';
  return {
    ...session,
    status,
    updatedAt: now,
    unread,
    ...(latestEvent === undefined ? {} : { latestEvent }),
    ...(exitCode === undefined ? {} : { exitCode })
  };
}

export function markSessionRead(
  session: AgentSession,
  now = Date.now()
): AgentSession {
  return { ...session, unread: false, updatedAt: now };
}

export function summarizeSessions(sessions: readonly AgentSession[]): string {
  const active = sessions.filter(isActiveSession).length;
  const attention = sessions.filter(
    (session) => session.status === 'attention'
  ).length;
  if (sessions.length === 0) {
    return 'No agents';
  }
  if (attention > 0) {
    return `${active} active · ${attention} need attention`;
  }
  return `${active} active · ${sessions.length} total`;
}

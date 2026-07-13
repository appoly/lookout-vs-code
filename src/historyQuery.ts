import { safeEventPresentation } from './sessionEventPresentation';
import { providerFor } from './providers/providerRegistry';
import type {
  CoordinatedSession,
  CoordinatedWindow
} from './coordinationModel';
import type { SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export type HistoryAvailability =
  | 'open'
  | 'resumable'
  | 'terminal-only'
  | 'closed'
  | 'archived';

export interface HistoryEntry {
  readonly session: AgentSession;
  readonly availability: HistoryAvailability;
  readonly latestEvent?: SessionEvent;
  readonly lastActivityAt: number;
}

export function buildHistoryEntries(
  sessions: readonly AgentSession[],
  events: readonly SessionEvent[],
  isOpen: (sessionId: string) => boolean,
  maximum = 100
): HistoryEntry[] {
  const latestBySession = new Map<string, SessionEvent>();
  for (const event of events) {
    const existing = latestBySession.get(event.sessionId);
    if (!existing || existing.sequence < event.sequence) {
      latestBySession.set(event.sessionId, event);
    }
  }
  return sessions
    .map((session): HistoryEntry => {
      const latestEvent = latestBySession.get(session.id);
      return {
        session,
        availability: historyAvailability(session, isOpen(session.id)),
        ...(latestEvent ? { latestEvent } : {}),
        lastActivityAt: Math.max(
          session.updatedAt,
          latestEvent?.observedAt ?? session.updatedAt
        )
      };
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    .slice(0, Math.max(1, maximum));
}

export function historyAvailability(
  session: AgentSession,
  open: boolean
): HistoryAvailability {
  if (session.archivedAt !== undefined) {
    return 'archived';
  }
  if (open) {
    return 'open';
  }
  const provider = providerFor(session.kind);
  const reference = session.providerSessions.at(-1);
  if (session.kind === 'custom' || !reference) {
    return 'terminal-only';
  }
  if (
    provider.capabilities.resume.support === 'supported' &&
    reference.state === 'available'
  ) {
    return 'resumable';
  }
  return 'closed';
}

export function historyAvailabilityLabel(value: HistoryAvailability): string {
  switch (value) {
    case 'open':
      return 'Open terminal';
    case 'resumable':
      return 'Resumable';
    case 'terminal-only':
      return 'Terminal-only history';
    case 'closed':
      return 'Closed';
    case 'archived':
      return 'Archived in Lookout';
  }
}

export function safeHistoryLatestEvent(event: SessionEvent | undefined): string {
  return event ? safeEventPresentation(event).label : 'No recorded events';
}

export interface LiveCoordinatedSession {
  readonly window: CoordinatedWindow;
  readonly session: CoordinatedSession;
}

/**
 * One row per live session. A window reload re-registers under a fresh window
 * ID while the previous lease has not yet expired, so the same session can be
 * reported by two coordinated windows for up to the lease duration.
 */
export function dedupeCoordinatedSessions(
  windows: readonly CoordinatedWindow[]
): LiveCoordinatedSession[] {
  const byKey = new Map<string, LiveCoordinatedSession>();
  for (const window of windows) {
    for (const session of window.sessions) {
      const key = liveSessionKey(window.workspaceKey, session.sessionId);
      const existing = byKey.get(key);
      if (!existing || existing.window.observedAt < window.observedAt) {
        byKey.set(key, { window, session });
      }
    }
  }
  return [...byKey.values()];
}

export function liveSessionKey(
  workspaceKey: string,
  sessionId: string
): string {
  return `${workspaceKey}\u0000${sessionId}`;
}

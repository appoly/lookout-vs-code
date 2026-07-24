import type { AgentSession } from './types';

/**
 * Chooses which of a worktree's attached sessions anchor its review context.
 *
 * One physical worktree has one review context, anchored on the earliest
 * attached session so that already-reviewed changes do not disappear as newer
 * sessions attach. "Attached" means open: a closed session holds no terminal, so
 * anchoring on one lets long-dead history dictate the baseline branch — marking
 * the group permanently stale against the current branch — and the context start
 * time, which admits unrelated documents as agent artifacts.
 *
 * Sessions are expected to be pre-sorted oldest first. The full list is returned
 * only when nothing is open, so a context mid-teardown still renders instead of
 * vanishing.
 */
export function anchoredSessions(
  sorted: readonly AgentSession[],
  isOpen: (sessionId: string) => boolean
): readonly AgentSession[] {
  const open = sorted.filter((session) => isOpen(session.id));
  return open.length > 0 ? open : sorted;
}

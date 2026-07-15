export interface RestoredSessionKey {
  readonly id: string;
  readonly terminalName: string;
}

export interface RestoredTerminalKey<T> {
  readonly value: T;
  readonly name: string;
  readonly sessionId?: string;
}

/**
 * Match persisted sessions to open terminals without ever claiming one
 * terminal twice. Name-only restoration is deliberately refused when either
 * side is ambiguous.
 */
export function matchRestoredTerminals<T>(
  sessions: readonly RestoredSessionKey[],
  terminals: readonly RestoredTerminalKey<T>[]
): Map<string, T> {
  const matches = new Map<string, T>();
  const claimed = new Set<T>();

  for (const session of sessions) {
    const exact = terminals.filter(
      (terminal) =>
        terminal.sessionId === session.id && !claimed.has(terminal.value)
    );
    if (exact.length === 1) {
      matches.set(session.id, exact[0].value);
      claimed.add(exact[0].value);
    }
  }

  const unmatchedSessionsByName = new Map<string, RestoredSessionKey[]>();
  for (const session of sessions) {
    if (!matches.has(session.id)) {
      const group = unmatchedSessionsByName.get(session.terminalName) ?? [];
      group.push(session);
      unmatchedSessionsByName.set(session.terminalName, group);
    }
  }
  for (const [name, unmatchedSessions] of unmatchedSessionsByName) {
    const candidates = terminals.filter(
      (terminal) =>
        terminal.name === name &&
        terminal.sessionId === undefined &&
        !claimed.has(terminal.value)
    );
    if (unmatchedSessions.length !== 1 || candidates.length !== 1) {
      continue;
    }
    matches.set(unmatchedSessions[0].id, candidates[0].value);
    claimed.add(candidates[0].value);
  }

  return matches;
}

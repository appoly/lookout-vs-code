import { randomUUID } from 'node:crypto';
import type { AgentKind, SessionStatus } from './types';
import type { ExecutionHostKind } from './globalHistoryModel';

export const COORDINATION_PROTOCOL_VERSION = 1 as const;
export const COORDINATION_HEARTBEAT_MS = 4_000;
export const COORDINATION_LEASE_MS = 15_000;
export const COORDINATION_MAX_WINDOWS = 32;
export const COORDINATION_MAX_SESSIONS_PER_WINDOW = 100;
export const COORDINATION_MAX_ACTIONS_PER_WINDOW = 50;

export interface CoordinatedSession {
  readonly sessionId: string;
  readonly label: string;
  readonly kind: AgentKind;
  readonly status: SessionStatus;
  readonly unread: boolean;
  readonly updatedAt: number;
  readonly providerSessionFingerprint?: string;
}

export interface CoordinatedWindowRegistration {
  readonly protocolVersion: typeof COORDINATION_PROTOCOL_VERSION;
  readonly windowId: string;
  readonly workspaceKey: string;
  readonly workspaceLabel: string;
  readonly hostKind: ExecutionHostKind;
  readonly observedAt: number;
  readonly sessions: readonly CoordinatedSession[];
}

export interface CoordinatedWindow extends CoordinatedWindowRegistration {
  readonly leaseExpiresAt: number;
}

export interface CoordinationAction {
  readonly id: string;
  readonly kind: 'focus-session';
  readonly sourceWindowId: string;
  readonly targetWindowId: string;
  readonly sessionId: string;
  readonly createdAt: number;
}

export interface CoordinationHeartbeatResult {
  readonly protocolVersion: typeof COORDINATION_PROTOCOL_VERSION;
  readonly windows: readonly CoordinatedWindow[];
  readonly actions: readonly CoordinationAction[];
}

export class CoordinationRegistry {
  private readonly windows = new Map<string, CoordinatedWindow>();
  private readonly pendingActions = new Map<string, CoordinationAction[]>();

  public constructor(private readonly now: () => number = Date.now) {}

  public heartbeat(
    registration: CoordinatedWindowRegistration
  ): CoordinationHeartbeatResult {
    this.expire();
    const safe = sanitizeRegistration(registration);
    if (!this.windows.has(safe.windowId) && this.windows.size >= COORDINATION_MAX_WINDOWS) {
      const oldest = [...this.windows.values()].sort(
        (left, right) => left.leaseExpiresAt - right.leaseExpiresAt
      )[0];
      if (oldest) {
        this.windows.delete(oldest.windowId);
        this.pendingActions.delete(oldest.windowId);
      }
    }
    this.windows.set(safe.windowId, {
      ...safe,
      leaseExpiresAt: this.now() + COORDINATION_LEASE_MS
    });
    const actions = this.pendingActions.get(safe.windowId) ?? [];
    this.pendingActions.delete(safe.windowId);
    return {
      protocolVersion: COORDINATION_PROTOCOL_VERSION,
      windows: this.snapshot(safe.windowId),
      actions
    };
  }

  public queueFocus(
    sourceWindowId: string,
    targetWindowId: string,
    sessionId: string
  ): CoordinationAction | undefined {
    this.expire();
    const target = this.windows.get(targetWindowId);
    if (!target || !target.sessions.some((session) => session.sessionId === sessionId)) {
      return undefined;
    }
    const action: CoordinationAction = {
      id: randomUUID(),
      kind: 'focus-session',
      sourceWindowId: boundedToken(sourceWindowId, 160),
      targetWindowId: boundedToken(targetWindowId, 160),
      sessionId: boundedToken(sessionId, 160),
      createdAt: this.now()
    };
    const queue = this.pendingActions.get(targetWindowId) ?? [];
    queue.push(action);
    this.pendingActions.set(
      targetWindowId,
      queue.slice(-COORDINATION_MAX_ACTIONS_PER_WINDOW)
    );
    return action;
  }

  public snapshot(excludeWindowId?: string): CoordinatedWindow[] {
    this.expire();
    return [...this.windows.values()]
      .filter((window) => window.windowId !== excludeWindowId)
      .sort((left, right) => left.workspaceLabel.localeCompare(right.workspaceLabel))
      .slice(0, COORDINATION_MAX_WINDOWS);
  }

  public expire(): void {
    const now = this.now();
    for (const [windowId, window] of this.windows) {
      if (window.leaseExpiresAt <= now) {
        this.windows.delete(windowId);
        this.pendingActions.delete(windowId);
      }
    }
  }
}

export function decodeRegistration(
  value: unknown
): CoordinatedWindowRegistration | undefined {
  if (!isObject(value) || value.protocolVersion !== COORDINATION_PROTOCOL_VERSION) {
    return undefined;
  }
  if (
    typeof value.windowId !== 'string' ||
    typeof value.workspaceKey !== 'string' ||
    typeof value.workspaceLabel !== 'string' ||
    !isHostKind(value.hostKind) ||
    typeof value.observedAt !== 'number' ||
    !Array.isArray(value.sessions)
  ) {
    return undefined;
  }
  const sessions = value.sessions.flatMap(decodeSession);
  return sanitizeRegistration({
    protocolVersion: COORDINATION_PROTOCOL_VERSION,
    windowId: value.windowId,
    workspaceKey: value.workspaceKey,
    workspaceLabel: value.workspaceLabel,
    hostKind: value.hostKind,
    observedAt: value.observedAt,
    sessions
  });
}

export function decodeFocusRequest(value: unknown): {
  readonly sourceWindowId: string;
  readonly targetWindowId: string;
  readonly sessionId: string;
} | undefined {
  if (
    !isObject(value) ||
    typeof value.sourceWindowId !== 'string' ||
    typeof value.targetWindowId !== 'string' ||
    typeof value.sessionId !== 'string'
  ) {
    return undefined;
  }
  return {
    sourceWindowId: boundedToken(value.sourceWindowId, 160),
    targetWindowId: boundedToken(value.targetWindowId, 160),
    sessionId: boundedToken(value.sessionId, 160)
  };
}

function sanitizeRegistration(
  value: CoordinatedWindowRegistration
): CoordinatedWindowRegistration {
  return {
    protocolVersion: COORDINATION_PROTOCOL_VERSION,
    windowId: boundedToken(value.windowId, 160),
    workspaceKey: boundedToken(value.workspaceKey, 160),
    workspaceLabel: boundedText(value.workspaceLabel, 160, 'Workspace'),
    hostKind: value.hostKind,
    observedAt: safeTime(value.observedAt),
    sessions: value.sessions.slice(0, COORDINATION_MAX_SESSIONS_PER_WINDOW).map(
      (session) => ({
        sessionId: boundedToken(session.sessionId, 160),
        label: boundedText(session.label, 120, 'Agent session'),
        kind: session.kind,
        status: session.status,
        unread: session.unread,
        updatedAt: safeTime(session.updatedAt),
        ...(session.providerSessionFingerprint
          ? {
              providerSessionFingerprint: boundedToken(
                session.providerSessionFingerprint,
                128
              )
            }
          : {})
      })
    )
  };
}

function decodeSession(value: unknown): CoordinatedSession[] {
  if (
    !isObject(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.label !== 'string' ||
    !isAgentKind(value.kind) ||
    !isSessionStatus(value.status) ||
    typeof value.updatedAt !== 'number'
  ) {
    return [];
  }
  return [{
    sessionId: value.sessionId,
    label: value.label,
    kind: value.kind,
    status: value.status,
    unread: value.unread === true,
    updatedAt: value.updatedAt,
    ...(typeof value.providerSessionFingerprint === 'string'
      ? { providerSessionFingerprint: value.providerSessionFingerprint }
      : {})
  }];
}

function boundedText(value: string, maximum: number, fallback: string): string {
  const cleaned = stripControls(value, false).trim();
  return cleaned ? cleaned.slice(0, maximum) : fallback;
}

function boundedToken(value: string, maximum: number): string {
  return stripControls(value, true).slice(0, maximum);
}

function stripControls(value: string, removeWhitespace: boolean): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || code === 127 || (removeWhitespace && /\s/.test(character))) {
        return removeWhitespace ? '' : ' ';
      }
      return character;
    })
    .join('');
}

function safeTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === 'codex' || value === 'claude' || value === 'custom';
}

function isHostKind(value: unknown): value is ExecutionHostKind {
  return value === 'local' || value === 'wsl' || value === 'ssh' ||
    value === 'dev-container' || value === 'other';
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === 'starting' || value === 'active' || value === 'running' ||
    value === 'background' || value === 'attention' || value === 'idle' ||
    value === 'completed' || value === 'failed' || value === 'unknown' ||
    value === 'closed';
}

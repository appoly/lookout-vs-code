export type AgentKind = 'codex' | 'claude' | 'custom';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'attention'
  | 'completed'
  | 'failed'
  | 'closed';

export interface AgentSession {
  readonly id: string;
  readonly kind: AgentKind;
  label: string;
  readonly command: string;
  readonly cwd: string;
  status: SessionStatus;
  readonly createdAt: number;
  updatedAt: number;
  terminalName: string;
  unread: boolean;
  latestEvent?: string;
  exitCode?: number;
}

export interface AgentEvent {
  readonly sessionId: string;
  readonly status: Extract<
    SessionStatus,
    'running' | 'attention' | 'completed' | 'failed'
  >;
  readonly message?: string;
  readonly exitCode?: number;
}

export interface LaunchRequest {
  readonly kind: AgentKind;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly parentSessionId?: string;
}

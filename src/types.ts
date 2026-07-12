export type AgentKind = 'codex' | 'claude' | 'custom';

export type SessionStatus =
  | 'starting'
  | 'active'
  | 'running'
  | 'background'
  | 'attention'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'unknown'
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
  bridgeAvailable: boolean;
  unread: boolean;
  backgroundAgents: BackgroundAgent[];
  runningCommands: RunningCommand[];
  foregroundState: ForegroundState;
  latestEvent?: string;
  exitCode?: number;
  readonly baseline?: GitBaseline;
}

export interface BackgroundAgent {
  readonly id: string;
  readonly label: string;
}

// A shell command an agent is running right now (a build, a test run, a dev
// server). Started/stopped by provider tool-use hooks, never inferred from
// terminal output (D3). Quick commands come and go before a human notices;
// only genuinely long-running ones linger in the list.
export interface RunningCommand {
  readonly id: string;
  readonly command: string;
}

// Why the foreground turn is not currently working: 'stopped' means it waits
// for the user, 'done' means the turn ended cleanly. The distinction decides
// whether draining the last delegated agent lands on 'attention' or 'idle'.
export type ForegroundState = 'unknown' | 'working' | 'stopped' | 'done';

export interface GitBaseline {
  readonly repoRoot: string;
  readonly commit: string;
  readonly branch: string;
  readonly capturedAt: number;
}

export type AgentReportedStatus = Extract<
  SessionStatus,
  'running' | 'attention' | 'completed' | 'failed'
>;

export interface AgentStatusEvent {
  readonly kind: 'status';
  readonly sessionId: string;
  readonly status: AgentReportedStatus;
  readonly message?: string;
  readonly exitCode?: number;
}

export interface AgentForegroundStopEvent {
  readonly kind: 'foreground-stop';
  readonly sessionId: string;
  readonly message?: string;
  // 'turn-end' marks a plain turn completion (nothing pending); absent means the
  // stop is a genuine wait for input (a permission prompt or Claude's idle nudge).
  readonly reason?: 'turn-end';
}

export interface AgentBackgroundEvent {
  readonly kind: 'background-start' | 'background-stop';
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentLabel: string;
}

export interface AgentCommandEvent {
  readonly kind: 'command-start' | 'command-stop';
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
}

export type AgentEvent =
  | AgentStatusEvent
  | AgentForegroundStopEvent
  | AgentBackgroundEvent
  | AgentCommandEvent;

export interface LaunchRequest {
  readonly kind: AgentKind;
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly parentSessionId?: string;
}

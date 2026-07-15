export type AgentKind = 'codex' | 'claude' | 'custom';

export type ManagedAgentKind = Extract<AgentKind, 'codex' | 'claude'>;

export type ProviderSessionSource = 'startup' | 'resume' | 'clear' | 'compact';

export interface ProviderSessionReference {
  readonly provider: ManagedAgentKind;
  readonly id: string;
  readonly firstSeenAt: number;
  lastSeenAt: number;
  state: 'available' | 'provider-archived' | 'unavailable' | 'unknown';
}

export interface SessionLineage {
  readonly operation: 'new' | 'resume' | 'fork' | 'reopen';
  readonly sourceLookoutSessionId?: string;
  readonly sourceProviderSessionId?: string;
}

export interface SessionIntegration {
  lifecycle:
    | 'disabled'
    | 'bridge-unavailable'
    | 'injection-skipped'
    | 'awaiting-first-hook'
    | 'healthy'
    | 'stale';
  hookTrust: 'not-applicable' | 'unknown' | 'observed';
  lastHookAt?: number;
  expectedProviderSessionId?: string;
  conflict?: string;
}

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
  readonly providerCommand?: string;
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
  providerSessions: ProviderSessionReference[];
  lineage: SessionLineage;
  integration: SessionIntegration;
  tokenUsage?: SessionTokenUsage;
  tokenBudget?: SessionTokenBudget;
  archivedAt?: number;
  latestEvent?: string;
  exitCode?: number;
  readonly baseline?: GitBaseline;
}

export interface SessionTokenUsage {
  readonly source: 'claude-statusline';
  readonly observedAt: number;
  /** Tokens currently occupying Claude's context, not cumulative session spend. */
  readonly contextTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly contextWindowTokens?: number;
  readonly contextUsedPercent?: number;
  readonly totalCostUsd?: number;
  readonly delegatedAgents: readonly DelegatedAgentTokenUsage[];
}

export interface DelegatedAgentTokenUsage {
  readonly id: string;
  readonly label: string;
  readonly tokenCount: number;
  readonly status?: string;
}

export interface SessionTokenBudget {
  readonly kind: 'codex-rollout' | 'claude-context-warning';
  readonly limitTokens: number;
}

export interface BackgroundAgent {
  readonly id: string;
  readonly label: string;
}

// A shell command or MCP call an agent is running right now. Started/stopped
// by provider tool-use hooks, never inferred from terminal output (D3). MCP
// arguments are never retained; only the provider's bounded tool identifier.
export interface RunningCommand {
  readonly id: string;
  readonly command: string;
  readonly activityKind?: 'mcp';
}

// An explicitly opted-in, bounded result from a provider shell-tool hook. This
// deliberately lives outside AgentSession so command output is never persisted.
export interface CommandResult {
  readonly id: string;
  readonly command: string;
  readonly outcome: 'completed' | 'failed' | 'interrupted';
  readonly completedAt: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
  readonly truncated?: boolean;
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

export interface ProviderEventMetadata {
  readonly provider?: ManagedAgentKind;
  readonly providerSessionId?: string;
  readonly providerSessionSource?: ProviderSessionSource;
}

export interface ProviderSessionEvent extends ProviderEventMetadata {
  readonly kind: 'provider-session';
  readonly sessionId: string;
  readonly provider: ManagedAgentKind;
  readonly providerSessionId: string;
}

export interface AgentStatusEvent extends ProviderEventMetadata {
  readonly kind: 'status';
  readonly sessionId: string;
  readonly status: AgentReportedStatus;
  readonly message?: string;
  readonly exitCode?: number;
}

export interface AgentForegroundStopEvent extends ProviderEventMetadata {
  readonly kind: 'foreground-stop';
  readonly sessionId: string;
  readonly message?: string;
  // 'turn-end' marks a plain turn completion (nothing pending); absent means the
  // stop is a genuine wait for input (a permission prompt or Claude's idle nudge).
  readonly reason?: 'turn-end';
}

export interface AgentBackgroundEvent extends ProviderEventMetadata {
  readonly kind: 'background-start' | 'background-stop';
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentLabel: string;
}

export interface AgentCommandEvent extends ProviderEventMetadata {
  readonly kind: 'command-start' | 'command-stop';
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: string;
  readonly activityKind?: 'mcp';
  readonly result?: Omit<CommandResult, 'id' | 'command' | 'completedAt'>;
}

export type AgentEvent =
  | ProviderSessionEvent
  | AgentStatusEvent
  | AgentForegroundStopEvent
  | AgentBackgroundEvent
  | AgentCommandEvent;

export interface LaunchRequest {
  readonly kind: AgentKind;
  /** Explicit label; omitted for plain launches so Lookout infers one. */
  readonly label?: string;
  readonly command: string;
  readonly cwd: string;
  readonly parentSessionId?: string;
  readonly lineage?: SessionLineage;
  readonly expectedProviderSessionId?: string;
  readonly providerCommand?: string;
}

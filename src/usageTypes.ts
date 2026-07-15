import type {
  DelegatedAgentTokenUsage,
  SessionTokenUsage
} from './types';

export type UsageProviderId = 'codex' | 'claude';

export type UsageStatus =
  | 'available'
  | 'waiting'
  | 'unsupported'
  | 'authRequired'
  | 'stale'
  | 'error';

export interface UsageWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt?: number;
  readonly windowMinutes?: number;
}

export interface UsageSnapshot {
  readonly provider: UsageProviderId;
  readonly status: UsageStatus;
  readonly observedAt: number;
  readonly source: 'codex-app-server' | 'claude-statusline';
  readonly windows: readonly UsageWindow[];
  readonly detail?: string;
  readonly plan?: string;
  readonly credits?: {
    readonly balance?: string;
    readonly unlimited?: boolean;
    readonly resetCount?: number;
  };
}

interface UsageBridgeEventBase {
  readonly provider: 'claude';
  readonly observedAt: number;
  readonly sessionId?: string;
}

export interface UsageSnapshotBridgeEvent extends UsageBridgeEventBase {
  readonly kind?: 'snapshot';
  readonly windows: readonly UsageWindow[];
  readonly tokenUsage?: SessionTokenUsage;
}

export interface DelegatedUsageBridgeEvent extends UsageBridgeEventBase {
  readonly kind: 'delegated-agents';
  readonly sessionId: string;
  readonly delegatedAgents: readonly DelegatedAgentTokenUsage[];
}

export type UsageBridgeEvent =
  | UsageSnapshotBridgeEvent
  | DelegatedUsageBridgeEvent;

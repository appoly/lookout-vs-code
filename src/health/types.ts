export type HealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'blocked'
  | 'unknown';

export type HealthCheckCode =
  | 'workspace-trust'
  | 'remote-authority'
  | 'git'
  | 'node'
  | 'profile-codex'
  | 'profile-claude'
  | 'profile-generic'
  | 'attention-bridge'
  | 'provider-lifecycle'
  | 'provider-identity'
  | 'usage-codex'
  | 'usage-claude'
  | 'git-baseline'
  | 'global-history'
  | 'cross-window-coordination';

export type RemediationCode =
  | 'none'
  | 'trust-workspace'
  | 'install-git'
  | 'install-node'
  | 'configure-codex'
  | 'configure-claude'
  | 'configure-generic-profile'
  | 'launch-new-session'
  | 'review-provider-hooks'
  | 'resolve-provider-session-conflict'
  | 'sign-in-codex'
  | 'sign-in-claude'
  | 'refresh-usage'
  | 'refresh-git-baseline'
  | 'enable-cross-window-coordination';

export type RemoteKind =
  | 'local'
  | 'wsl'
  | 'ssh'
  | 'dev-container'
  | 'other';

export interface HealthCheck {
  readonly code: HealthCheckCode;
  readonly status: HealthStatus;
  readonly summary: string;
  readonly remediation: RemediationCode;
  /** Safe ordinal such as "session-1"; never a Lookout or provider ID. */
  readonly scope?: string;
}

export interface HealthReport {
  readonly version: 1;
  readonly observedAt: number;
  readonly remoteKind: RemoteKind;
  readonly checks: readonly HealthCheck[];
  readonly totals: Readonly<Record<HealthStatus, number>>;
}

export type DependencyState = 'available' | 'missing' | 'unknown';
export type ProfileState =
  | 'available'
  | 'missing'
  | 'unconfigured'
  | 'not-direct'
  | 'error'
  | 'configuration-required';
export type BridgeState = 'available' | 'degraded' | 'unavailable' | 'unknown';
export type LifecycleState =
  | 'healthy'
  | 'needs-trust'
  | 'degraded'
  | 'unavailable'
  | 'unknown';
export type ProviderIdentityState =
  | 'observed'
  | 'expected'
  | 'conflict'
  | 'unavailable'
  | 'unknown';
export type UsageHealthState =
  | 'current'
  | 'stale'
  | 'waiting'
  | 'signed-out'
  | 'unsupported'
  | 'disabled'
  | 'unknown';
export type BaselineHealthState =
  | 'fresh'
  | 'stale'
  | 'unavailable'
  | 'not-git'
  | 'unknown';

export interface ProfileHealthInput {
  readonly kind: 'codex' | 'claude' | 'generic';
  readonly state: ProfileState;
}

export interface SessionHealthInput {
  readonly bridge: BridgeState;
  readonly lifecycle: LifecycleState;
  readonly providerIdentity: ProviderIdentityState;
  readonly baseline: BaselineHealthState;
}

export interface UsageHealthInput {
  readonly provider: 'codex' | 'claude';
  readonly state: UsageHealthState;
}

export interface HealthInputs {
  readonly observedAt: number;
  readonly workspaceTrusted: boolean;
  readonly remoteKind: RemoteKind;
  readonly git: DependencyState;
  readonly node: DependencyState;
  readonly profiles: readonly ProfileHealthInput[];
  readonly sessions: readonly SessionHealthInput[];
  readonly usage: readonly UsageHealthInput[];
  readonly globalHistory?: 'current' | 'disabled' | 'unavailable';
  readonly coordination?:
    | 'disabled'
    | 'starting'
    | 'healthy-owner'
    | 'healthy-client'
    | 'degraded'
    | 'incompatible';
}

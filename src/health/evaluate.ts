import type {
  BaselineHealthState,
  BridgeState,
  HealthCheck,
  HealthInputs,
  HealthReport,
  HealthStatus,
  LifecycleState,
  ProfileHealthInput,
  ProviderIdentityState,
  RemediationCode,
  UsageHealthInput
} from './types';

export function evaluateHealth(inputs: HealthInputs): HealthReport {
  const checks: HealthCheck[] = [
    inputs.workspaceTrusted
      ? check('workspace-trust', 'healthy', 'Workspace is trusted.', 'none')
      : check(
          'workspace-trust',
          'blocked',
          'Command execution is blocked by Workspace Trust.',
          'trust-workspace'
        ),
    check(
      'remote-authority',
      'healthy',
      inputs.remoteKind === 'local'
        ? 'Extension host is local.'
        : `Extension host is scoped to ${remoteLabel(inputs.remoteKind)}.`,
      'none'
    ),
    dependencyCheck(inputs.git, 'git'),
    dependencyCheck(inputs.node, 'node'),
    ...inputs.profiles.map(profileCheck),
    ...inputs.sessions.flatMap((session, index) => {
      const scope = `session-${index + 1}`;
      return [
        bridgeCheck(session.bridge, scope),
        lifecycleCheck(session.lifecycle, scope),
        identityCheck(session.providerIdentity, scope),
        baselineCheck(session.baseline, scope)
      ];
    }),
    ...inputs.usage.map(usageCheck),
    ...(inputs.globalHistory ? [globalHistoryCheck(inputs.globalHistory)] : []),
    ...(inputs.coordination ? [coordinationCheck(inputs.coordination)] : [])
  ];
  const totals: Record<HealthStatus, number> = {
    healthy: 0,
    degraded: 0,
    unavailable: 0,
    blocked: 0,
    unknown: 0
  };
  for (const item of checks) {
    totals[item.status] += 1;
  }
  return {
    version: 1,
    observedAt: inputs.observedAt,
    remoteKind: inputs.remoteKind,
    checks,
    totals
  };
}

function globalHistoryCheck(
  state: NonNullable<HealthInputs['globalHistory']>
): HealthCheck {
  switch (state) {
    case 'current':
      return check(
        'global-history',
        'healthy',
        'Cross-project history is available on this execution host.',
        'none'
      );
    case 'disabled':
      return check(
        'global-history',
        'degraded',
        'Cross-project history is disabled.',
        'none'
      );
    case 'unavailable':
      return check(
        'global-history',
        'unavailable',
        'Cross-project history storage is unavailable.',
        'none'
      );
  }
}

function coordinationCheck(
  state: NonNullable<HealthInputs['coordination']>
): HealthCheck {
  switch (state) {
    case 'healthy-owner':
      return check(
        'cross-window-coordination',
        'healthy',
        'This window owns the execution-host coordinator.',
        'none'
      );
    case 'healthy-client':
      return check(
        'cross-window-coordination',
        'healthy',
        'This window is connected to the execution-host coordinator.',
        'none'
      );
    case 'starting':
      return check(
        'cross-window-coordination',
        'unknown',
        'Cross-window coordination is starting.',
        'none'
      );
    case 'disabled':
      return check(
        'cross-window-coordination',
        'healthy',
        'Experimental cross-window coordination is disabled.',
        'enable-cross-window-coordination'
      );
    case 'degraded':
      return check(
        'cross-window-coordination',
        'degraded',
        'Cross-window coordination is unavailable on this execution host.',
        'enable-cross-window-coordination'
      );
    case 'incompatible':
      return check(
        'cross-window-coordination',
        'blocked',
        'Another Lookout protocol version owns the coordinator.',
        'none'
      );
  }
}

function dependencyCheck(
  state: HealthInputs['git'],
  kind: 'git' | 'node'
): HealthCheck {
  const name = kind === 'git' ? 'Git' : 'Node.js';
  const remediation = kind === 'git' ? 'install-git' : 'install-node';
  if (state === 'available') {
    return check(kind, 'healthy', `${name} is available.`, 'none');
  }
  if (state === 'missing') {
    return check(kind, 'unavailable', `${name} is not available.`, remediation);
  }
  return check(kind, 'unknown', `${name} availability is unknown.`, remediation);
}

function profileCheck(profile: ProfileHealthInput): HealthCheck {
  const code = `profile-${profile.kind}` as const;
  const name = profile.kind === 'generic'
    ? 'Generic profile'
    : profile.kind === 'codex'
      ? 'Codex profile'
      : 'Claude profile';
  const remediation: RemediationCode = profile.kind === 'codex'
    ? 'configure-codex'
    : profile.kind === 'claude'
      ? 'configure-claude'
      : 'configure-generic-profile';
  switch (profile.state) {
    case 'available':
      return check(code, 'healthy', `${name} is available.`, 'none');
    case 'not-direct':
      return check(
        code,
        'degraded',
        `${name} uses a wrapper; deep integration is limited.`,
        remediation
      );
    case 'configuration-required':
    case 'unconfigured':
      return check(code, 'degraded', `${name} requires configuration.`, remediation);
    case 'missing':
      return check(code, 'unavailable', `${name} executable is unavailable.`, remediation);
    case 'error':
      return check(code, 'unknown', `${name} detection failed.`, remediation);
  }
}

function bridgeCheck(state: BridgeState, scope: string): HealthCheck {
  switch (state) {
    case 'available':
      return check('attention-bridge', 'healthy', 'Attention bridge is available.', 'none', scope);
    case 'degraded':
      return check('attention-bridge', 'degraded', 'Attention bridge is degraded.', 'launch-new-session', scope);
    case 'unavailable':
      return check('attention-bridge', 'unavailable', 'Attention bridge is unavailable.', 'launch-new-session', scope);
    case 'unknown':
      return check('attention-bridge', 'unknown', 'Attention bridge state is unknown.', 'launch-new-session', scope);
  }
}

function lifecycleCheck(state: LifecycleState, scope: string): HealthCheck {
  switch (state) {
    case 'healthy':
      return check('provider-lifecycle', 'healthy', 'Provider lifecycle events are healthy.', 'none', scope);
    case 'needs-trust':
      return check('provider-lifecycle', 'degraded', 'Provider hooks require trust review.', 'review-provider-hooks', scope);
    case 'degraded':
      return check('provider-lifecycle', 'degraded', 'Provider lifecycle events are degraded.', 'launch-new-session', scope);
    case 'unavailable':
      return check('provider-lifecycle', 'unavailable', 'Provider lifecycle events are unavailable.', 'launch-new-session', scope);
    case 'unknown':
      return check('provider-lifecycle', 'unknown', 'Provider lifecycle state is unknown.', 'launch-new-session', scope);
  }
}

function identityCheck(state: ProviderIdentityState, scope: string): HealthCheck {
  switch (state) {
    case 'observed':
      return check('provider-identity', 'healthy', 'Provider session identity was observed.', 'none', scope);
    case 'expected':
      return check('provider-identity', 'degraded', 'Provider session identity is awaiting confirmation.', 'launch-new-session', scope);
    case 'conflict':
      return check('provider-identity', 'blocked', 'Provider session identity conflicts with the expected session.', 'resolve-provider-session-conflict', scope);
    case 'unavailable':
      return check('provider-identity', 'unavailable', 'Provider session identity is unavailable.', 'launch-new-session', scope);
    case 'unknown':
      return check('provider-identity', 'unknown', 'Provider session identity is unknown.', 'launch-new-session', scope);
  }
}

function usageCheck(input: UsageHealthInput): HealthCheck {
  const code = input.provider === 'codex' ? 'usage-codex' : 'usage-claude';
  const name = input.provider === 'codex' ? 'Codex' : 'Claude';
  const signIn: RemediationCode = input.provider === 'codex'
    ? 'sign-in-codex'
    : 'sign-in-claude';
  switch (input.state) {
    case 'current':
      return check(code, 'healthy', `${name} usage is current.`, 'none');
    case 'stale':
      return check(code, 'degraded', `${name} usage is stale.`, 'refresh-usage');
    case 'waiting':
      return check(code, 'unknown', `${name} usage is waiting for provider data.`, 'refresh-usage');
    case 'signed-out':
      return check(code, 'unavailable', `${name} usage requires authentication.`, signIn);
    case 'unsupported':
      return check(code, 'unavailable', `${name} usage is unsupported.`, 'none');
    case 'disabled':
      return check(code, 'healthy', `${name} usage is disabled by configuration.`, 'none');
    case 'unknown':
      return check(code, 'unknown', `${name} usage state is unknown.`, 'refresh-usage');
  }
}

function baselineCheck(state: BaselineHealthState, scope: string): HealthCheck {
  switch (state) {
    case 'fresh':
      return check('git-baseline', 'healthy', 'Git review baseline is fresh.', 'none', scope);
    case 'stale':
      return check('git-baseline', 'degraded', 'Git review baseline is stale.', 'refresh-git-baseline', scope);
    case 'unavailable':
      return check('git-baseline', 'unavailable', 'Git review baseline is unavailable.', 'refresh-git-baseline', scope);
    case 'not-git':
      return check('git-baseline', 'healthy', 'Session folder is not a Git worktree.', 'none', scope);
    case 'unknown':
      return check('git-baseline', 'unknown', 'Git review baseline state is unknown.', 'refresh-git-baseline', scope);
  }
}

function check(
  code: HealthCheck['code'],
  status: HealthStatus,
  summary: string,
  remediation: RemediationCode,
  scope?: string
): HealthCheck {
  return { code, status, summary, remediation, ...(scope ? { scope } : {}) };
}

function remoteLabel(kind: HealthInputs['remoteKind']): string {
  switch (kind) {
    case 'wsl': return 'WSL';
    case 'ssh': return 'Remote SSH';
    case 'dev-container': return 'a dev container';
    case 'other': return 'a remote authority';
    case 'local': return 'the local machine';
  }
}

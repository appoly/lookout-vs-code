import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDoctorReport } from '../src/doctor';
import { evaluateHealth, type HealthInputs } from '../src/health';

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    observedAt: Date.UTC(2026, 6, 12),
    workspaceTrusted: true,
    remoteKind: 'local',
    git: 'available',
    node: 'available',
    profiles: [
      { kind: 'codex', state: 'available' },
      { kind: 'claude', state: 'not-direct' },
      { kind: 'generic', state: 'configuration-required' }
    ],
    sessions: [
      {
        bridge: 'degraded',
        lifecycle: 'needs-trust',
        providerIdentity: 'conflict',
        baseline: 'stale'
      }
    ],
    usage: [
      { provider: 'codex', state: 'stale' },
      { provider: 'claude', state: 'signed-out' }
    ],
    ...overrides
  };
}

test('evaluates fixed health and remediation codes without session identifiers', () => {
  const report = evaluateHealth(inputs());
  assert.equal(report.version, 1);
  assert.equal(report.checks.some((item) => item.status === 'blocked'), true);
  assert.equal(
    report.checks.find((item) => item.code === 'provider-identity')?.remediation,
    'resolve-provider-session-conflict'
  );
  assert.equal(report.checks.some((item) => item.scope === 'session-1'), true);
  assert.equal(JSON.stringify(report).includes('providerSessionId'), false);
});

test('reports trust, dependencies, remote authority, usage, and baseline distinctly', () => {
  const report = evaluateHealth(inputs({
    workspaceTrusted: false,
    remoteKind: 'ssh',
    git: 'missing',
    node: 'unknown'
  }));
  assert.equal(report.checks.find((item) => item.code === 'workspace-trust')?.status, 'blocked');
  assert.equal(report.checks.find((item) => item.code === 'git')?.remediation, 'install-git');
  assert.equal(report.checks.find((item) => item.code === 'node')?.status, 'unknown');
  assert.match(report.checks.find((item) => item.code === 'remote-authority')?.summary ?? '', /Remote SSH/);
});

test('doctor formatting is line-safe and redacts injected token-shaped text', () => {
  const report = evaluateHealth(inputs());
  const malicious = {
    ...report,
    checks: [
      {
        ...report.checks[0],
        scope: 'session-1\nFORGED',
        summary: 'bad\nline Bearer CANARY_TOKEN_1234567890'
      }
    ]
  };
  const lines = formatDoctorReport(malicious, {
    extensionVersion: '0.1.0\nforged',
    vscodeVersion: '1.100.0',
    platform: 'win32'
  });
  assert.equal(lines.every((line) => !line.includes('\n')), true);
  assert.equal(lines.join('\n').includes('CANARY_TOKEN_1234567890'), false);
  assert.match(lines.join('\n'), /<redacted-secret>/);
});

test('reports global history and live coordination without host identifiers', () => {
  const report = evaluateHealth(inputs({
    globalHistory: 'current',
    coordination: 'healthy-client'
  }));
  assert.equal(
    report.checks.find((item) => item.code === 'global-history')?.status,
    'healthy'
  );
  assert.equal(
    report.checks.find((item) => item.code === 'cross-window-coordination')?.status,
    'healthy'
  );
  assert.doesNotMatch(JSON.stringify(report), /hostname|windowId|remote\.example/);
});

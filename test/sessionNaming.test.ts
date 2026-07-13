import assert from 'node:assert/strict';
import test from 'node:test';
import { inferSessionLabel, providerDisplayName } from '../src/sessionNaming';

test('names sessions after the provider and Git branch', () => {
  assert.equal(
    inferSessionLabel({
      kind: 'claude',
      cwd: '/home/user/code/lookout',
      branch: 'feature/session-names',
      existingLabels: []
    }),
    'Claude · feature/session-names'
  );
});

test('falls back to the working folder without a branch or when detached', () => {
  assert.equal(
    inferSessionLabel({
      kind: 'codex',
      cwd: '/home/user/code/lookout',
      existingLabels: []
    }),
    'Codex · lookout'
  );
  assert.equal(
    inferSessionLabel({
      kind: 'codex',
      cwd: '/home/user/code/lookout/',
      branch: 'HEAD',
      existingLabels: []
    }),
    'Codex · lookout'
  );
});

test('disambiguates repeated launches with an ordinal', () => {
  const existing = ['Claude · main', 'Claude · main 2'];
  assert.equal(
    inferSessionLabel({
      kind: 'claude',
      cwd: '/repo',
      branch: 'main',
      existingLabels: existing
    }),
    'Claude · main 3'
  );
});

test('bounds very long branch names', () => {
  const label = inferSessionLabel({
    kind: 'custom',
    cwd: '/repo',
    branch: `feature/${'x'.repeat(120)}`,
    existingLabels: []
  });
  assert.equal(label.startsWith('Custom · feature/'), true);
  assert.equal(label.endsWith('…'), true);
  assert.equal(label.length <= 'Custom · '.length + 60, true);
});

test('provider display names stay fixed', () => {
  assert.equal(providerDisplayName('codex'), 'Codex');
  assert.equal(providerDisplayName('claude'), 'Claude');
  assert.equal(providerDisplayName('custom'), 'Custom');
});

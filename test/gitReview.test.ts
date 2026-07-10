import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureGitBaseline,
  excludeWorkspaceArtifacts,
  listWorkspaceChanges,
  parseNameStatus,
  parseNullList,
  readGitWorktreeState,
  readBaselineFile
} from '../src/gitReview';

test('parses NUL-delimited Git status including renames', () => {
  assert.deepEqual(parseNullList('one\0two spaces\0'), ['one', 'two spaces']);
  assert.deepEqual(parseNameStatus('M\0src/a.ts\0R100\0old.ts\0new.ts\0'), [
    { kind: 'modified', path: 'src/a.ts', statusCode: 'M' },
    {
      kind: 'renamed',
      path: 'new.ts',
      previousPath: 'old.ts',
      statusCode: 'R100'
    }
  ]);
});

test('removes discovered plans and docs from ordinary workspace changes', () => {
  const changes = [
    { kind: 'modified' as const, path: 'src/main.ts', statusCode: 'M' },
    { kind: 'modified' as const, path: 'docs/plan.md', statusCode: 'M' }
  ];
  assert.deepEqual(
    excludeWorkspaceArtifacts(
      changes,
      '/repo',
      new Set(['/repo/docs/plan.md'])
    ),
    [changes[0]]
  );
});

test('captures a Git baseline and lists working tree changes', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'parful-git-'));
  try {
    git(directory, ['init', '-q']);
    git(directory, ['config', 'user.name', 'Parful Tests']);
    git(directory, ['config', 'user.email', 'parful@example.invalid']);
    writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
    git(directory, ['add', 'tracked.txt']);
    git(directory, ['commit', '-qm', 'baseline']);

    const baseline = await captureGitBaseline(directory);
    assert.ok(baseline);
    writeFileSync(path.join(directory, 'tracked.txt'), 'changed\n');
    writeFileSync(path.join(directory, 'new file.txt'), 'new\n');

    const changes = await listWorkspaceChanges(baseline);
    assert.deepEqual(
      changes.map(({ kind, path: filePath }) => [kind, filePath]),
      [
        ['modified', 'tracked.txt'],
        ['untracked', 'new file.txt']
      ]
    );
    assert.equal(await readBaselineFile(baseline, 'tracked.txt'), 'baseline\n');

    git(directory, ['checkout', '-qb', 'agent/second-branch']);
    const state = await readGitWorktreeState(directory);
    assert.equal(state.branch, 'agent/second-branch');
    assert.equal(state.repoRoot, directory);
    assert.equal(state.repositoryName, path.basename(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

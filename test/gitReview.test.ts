import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureGitBaseline,
  excludeWorkspaceArtifacts,
  listGitWorktrees,
  listUncommittedChanges,
  listWorkspaceChanges,
  parseNameStatus,
  parseNullList,
  parseWorktreeList,
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

test('parses linked and detached worktrees from porcelain output', () => {
  assert.deepEqual(
    parseWorktreeList(
      [
        'worktree /repo',
        'HEAD 1111111',
        'branch refs/heads/main',
        '',
        'worktree /repo worktree',
        'HEAD 2222222',
        'detached',
        '',
        ''
      ].join('\0')
    ),
    [
      { repoRoot: path.normalize('/repo'), commit: '1111111', branch: 'main' },
      {
        repoRoot: path.normalize('/repo worktree'),
        commit: '2222222',
        branch: 'HEAD'
      }
    ]
  );
});

test('captures a Git baseline and lists working tree changes', async () => {
  // Git reports canonical paths; the OS temp dir may be a symlink (macOS
  // /var -> /private/var) or an 8.3 short name (Windows RUNNER~1), so
  // canonicalize before comparing repo roots against it.
  const directory = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'lookout-git-'))
  );
  try {
    git(directory, ['init', '-q']);
    git(directory, ['config', 'user.name', 'Lookout Tests']);
    git(directory, ['config', 'user.email', 'lookout@example.invalid']);
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
    assert.equal((await listUncommittedChanges(directory)).length, 2);

    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'agent changes']);
    assert.equal((await listUncommittedChanges(directory)).length, 0);
    assert.deepEqual(
      (await listWorkspaceChanges(baseline)).map(
        ({ kind, path: filePath }) => [kind, filePath]
      ),
      [
        ['added', 'new file.txt'],
        ['modified', 'tracked.txt']
      ]
    );
    assert.equal(await readBaselineFile(baseline, 'tracked.txt'), 'baseline\n');

    git(directory, ['checkout', '-qb', 'agent/second-branch']);
    const state = await readGitWorktreeState(directory);
    assert.equal(state.branch, 'agent/second-branch');
    assert.equal(state.repoRoot, directory);
    assert.equal(state.repositoryName, path.basename(directory));

    const linked = `${directory}-linked`;
    git(directory, ['worktree', 'add', '-qb', 'agent/linked', linked]);
    try {
      assert.deepEqual(
        (await listGitWorktrees(directory)).map((worktree) => ({
          repoRoot: worktree.repoRoot,
          branch: worktree.branch
        })),
        [
          { repoRoot: directory, branch: 'agent/second-branch' },
          { repoRoot: linked, branch: 'agent/linked' }
        ]
      );
    } finally {
      git(directory, ['worktree', 'remove', '--force', linked]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

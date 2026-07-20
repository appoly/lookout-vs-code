import * as path from 'node:path';
import { runGitText } from './gitProcess';
import type { GitBaseline } from './types';

export type WorkspaceChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'other';

export interface WorkspaceChange {
  readonly kind: WorkspaceChangeKind;
  readonly path: string;
  readonly previousPath?: string;
  readonly statusCode: string;
}

export interface GitWorktreeState {
  readonly repoRoot: string;
  readonly repositoryName: string;
  readonly commit: string;
  readonly branch: string;
}

export interface GitWorktreeRegistration {
  readonly repoRoot: string;
  readonly commit: string;
  readonly branch: string;
}

export async function captureGitBaseline(
  cwd: string
): Promise<GitBaseline | undefined> {
  try {
    const state = await readGitWorktreeState(cwd);
    return {
      repoRoot: state.repoRoot,
      commit: state.commit,
      branch: state.branch,
      capturedAt: Date.now()
    };
  } catch {
    return undefined;
  }
}

export async function readGitWorktreeState(
  cwd: string
): Promise<GitWorktreeState> {
  const repoRoot = path.normalize(
    (await runGitText(cwd, ['rev-parse', '--show-toplevel'])).trim()
  );
  const [commit, branch, commonDirectoryValue] = await Promise.all([
    runGitText(repoRoot, ['rev-parse', 'HEAD']),
    runGitText(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGitText(repoRoot, ['rev-parse', '--git-common-dir'])
  ]);
  const commonDirectory = path.normalize(commonDirectoryValue.trim());
  const commonPath = path.isAbsolute(commonDirectory)
    ? commonDirectory
    : path.resolve(repoRoot, commonDirectory);
  const repositoryRoot = path.dirname(commonPath);
  return {
    repoRoot,
    repositoryName: path.basename(repositoryRoot),
    commit: commit.trim(),
    branch: branch.trim()
  };
}

/**
 * Lists every physical worktree registered with the repository containing
 * `cwd`. Claude and other providers can create these for delegated agents
 * without creating another Lookout terminal session.
 */
export async function listGitWorktrees(
  cwd: string
): Promise<GitWorktreeRegistration[]> {
  const output = await runGitText(cwd, [
    'worktree',
    'list',
    '--porcelain',
    '-z'
  ]);
  return parseWorktreeList(output);
}

export function parseWorktreeList(output: string): GitWorktreeRegistration[] {
  const records: GitWorktreeRegistration[] = [];
  let repoRoot: string | undefined;
  let commit: string | undefined;
  let branch = 'HEAD';

  const finish = (): void => {
    if (repoRoot && commit) {
      records.push({ repoRoot: path.normalize(repoRoot), commit, branch });
    }
    repoRoot = undefined;
    commit = undefined;
    branch = 'HEAD';
  };

  for (const field of output.split('\0')) {
    if (field === '') {
      finish();
    } else if (field.startsWith('worktree ')) {
      // Be tolerant of output without the optional blank record separator.
      if (repoRoot) {
        finish();
      }
      repoRoot = field.slice('worktree '.length);
    } else if (field.startsWith('HEAD ')) {
      commit = field.slice('HEAD '.length);
    } else if (field.startsWith('branch ')) {
      branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (field === 'detached') {
      branch = 'HEAD';
    }
  }
  finish();
  return records;
}

export async function listWorkspaceChanges(
  baseline: GitBaseline
): Promise<WorkspaceChange[]> {
  return listChangesSince(baseline.repoRoot, baseline.commit);
}

/**
 * Lists only changes that have not been committed in the current worktree.
 * Unlike listWorkspaceChanges, this deliberately ignores commits made since an
 * agent launched so a clean, committed branch is not presented as work at risk.
 */
export async function listUncommittedChanges(
  repoRoot: string
): Promise<WorkspaceChange[]> {
  return listChangesSince(repoRoot, 'HEAD');
}

async function listChangesSince(
  repoRoot: string,
  revision: string
): Promise<WorkspaceChange[]> {
  const [tracked, untracked] = await Promise.all([
    runGitText(repoRoot, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      revision,
      '--'
    ]),
    runGitText(repoRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--'
    ])
  ]);
  return [
    ...parseNameStatus(tracked),
    ...parseNullList(untracked).map((filePath) => ({
      kind: 'untracked' as const,
      path: filePath,
      statusCode: '?'
    }))
  ];
}

export async function readBaselineFile(
  baseline: GitBaseline,
  relativePath: string
): Promise<string> {
  const normalized = relativePath.split(path.sep).join('/');
  return runGitText(baseline.repoRoot, [
    'show',
    `${baseline.commit}:${normalized}`
  ]);
}

export function excludeWorkspaceArtifacts(
  changes: readonly WorkspaceChange[],
  repoRoot: string,
  artifactPaths: ReadonlySet<string>
): WorkspaceChange[] {
  if (artifactPaths.size === 0) {
    return [...changes];
  }
  const excluded = new Set(
    [...artifactPaths].map((artifactPath) => normalizeFsPath(artifactPath))
  );
  return changes.filter(
    (change) =>
      !excluded.has(normalizeFsPath(path.resolve(repoRoot, change.path)))
  );
}

export function parseNameStatus(output: string): WorkspaceChange[] {
  const fields = parseNullList(output);
  const changes: WorkspaceChange[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusCode = fields[index++];
    if (!statusCode) {
      break;
    }
    const status = statusCode.charAt(0);
    if (status === 'R' || status === 'C') {
      const previousPath = fields[index++];
      const filePath = fields[index++];
      if (previousPath && filePath) {
        changes.push({
          kind: status === 'R' ? 'renamed' : 'copied',
          path: filePath,
          previousPath,
          statusCode
        });
      }
      continue;
    }
    const filePath = fields[index++];
    if (filePath) {
      changes.push({
        kind: changeKind(status),
        path: filePath,
        statusCode
      });
    }
  }
  return changes;
}

export function parseNullList(output: string): string[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') {
    fields.pop();
  }
  return fields;
}

function changeKind(status: string): WorkspaceChangeKind {
  switch (status) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    default:
      return 'other';
  }
}

function normalizeFsPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

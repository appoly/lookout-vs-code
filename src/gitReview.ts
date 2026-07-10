import { execFile } from 'node:child_process';
import * as path from 'node:path';
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

export async function captureGitBaseline(
  cwd: string
): Promise<GitBaseline | undefined> {
  try {
    const repoRoot = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
    const commit = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
    const branch = (
      await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim();
    if (!repoRoot || !commit) {
      return undefined;
    }
    return { repoRoot, commit, branch, capturedAt: Date.now() };
  } catch {
    return undefined;
  }
}

export async function listWorkspaceChanges(
  baseline: GitBaseline
): Promise<WorkspaceChange[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(baseline.repoRoot, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      baseline.commit,
      '--'
    ]),
    runGit(baseline.repoRoot, [
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
  return runGit(baseline.repoRoot, [
    'show',
    `${baseline.commit}:${normalized}`
  ]);
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

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(String(stdout));
        }
      }
    );
  });
}

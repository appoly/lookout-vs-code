import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  ExecutionHostKind,
  WorkspaceIdentity
} from './globalHistoryModel';

export function currentWorkspaceIdentity(
  context: vscode.ExtensionContext
): WorkspaceIdentity | undefined {
  const workspaceFile = vscode.workspace.workspaceFile;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const locator = workspaceFile && workspaceFile.scheme !== 'untitled'
    ? workspaceFile
    : folders[0]?.uri;
  if (!locator) {
    return undefined;
  }
  const hostKind = executionHostKind(vscode.env.remoteName);
  const hostScope = createHash('sha256')
    .update(path.resolve(context.globalStorageUri.fsPath))
    .update('\0')
    .update(vscode.env.remoteName ?? 'local')
    .digest('hex');
  const workspaceSignature = workspaceFile && workspaceFile.scheme !== 'untitled'
    ? workspaceFile.toString(true)
    : folders
        .map((folder) => folder.uri.toString(true))
        .sort()
        .join('\0');
  const key = createHash('sha256')
    .update(hostScope)
    .update('\0')
    .update(workspaceSignature)
    .digest('hex');
  return {
    key,
    uri: locator.toString(true),
    label: workspaceLabel(locator, workspaceFile !== undefined),
    hostKind,
    hostScope
  };
}

export function executionHostKind(
  remoteName: string | undefined
): ExecutionHostKind {
  const remote = remoteName?.toLowerCase();
  if (!remote) {
    return 'local';
  }
  if (remote.includes('wsl')) {
    return 'wsl';
  }
  if (remote.includes('ssh')) {
    return 'ssh';
  }
  if (remote.includes('container')) {
    return 'dev-container';
  }
  return 'other';
}

function workspaceLabel(uri: vscode.Uri, workspaceFile: boolean): string {
  const base = path.basename(uri.fsPath || uri.path);
  if (!base) {
    return 'Workspace';
  }
  return workspaceFile
    ? base.replace(/\.code-workspace$/i, '') || 'Workspace'
    : base;
}

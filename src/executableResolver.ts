import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  resolvedPathFromProbeOutput,
  shellProbeInvocation
} from './executableProbe';

const SHELL_PROBE_TIMEOUT_MS = 5000;
const SHELL_PROBE_NEGATIVE_TTL_MS = 30_000;

interface ShellResolution {
  /** The shell can run the name — includes aliases and functions. */
  readonly runnable: boolean;
  /** A real file the extension host could spawn directly, when one exists. */
  readonly resolvedPath?: string;
}

const shellProbeResults = new Map<
  string,
  { value: ShellResolution; expires: number }
>();

/**
 * Whether the first token of a launch command can run. Paths are checked
 * directly; bare names are checked on the extension host PATH and then in
 * the default terminal shell, whose rc files can extend PATH beyond what a
 * GUI-launched extension host inherited (~/.local/bin, version-manager bin
 * dirs). Terminal sessions type their command into that shell, so a shell
 * alias or function also counts as available.
 */
export async function executableAvailable(command: string): Promise<boolean> {
  const token = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = token?.[1] ?? token?.[2] ?? token?.[3];
  if (!executable) {
    return false;
  }
  if (
    path.isAbsolute(executable) ||
    executable.includes('/') ||
    executable.includes('\\')
  ) {
    try {
      await access(executable);
      return true;
    } catch {
      return false;
    }
  }
  if (await hostPathHasExecutable(executable)) {
    return true;
  }
  return (await probeDefaultShell(executable)).runnable;
}

export function hostPathHasExecutable(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [executable],
      { windowsHide: true },
      (error) => resolve(!error)
    );
  });
}

/**
 * Host-side spawns (usage polling) resolve against the extension host PATH,
 * not the terminal shell's. When the host PATH misses a bare executable, ask
 * the default terminal shell where the file lives so the spawn can use that
 * path instead. Returns undefined when no override is needed or none exists.
 */
export async function hostSpawnPathOverride(
  executable: string
): Promise<string | undefined> {
  if (/[\\/]/.test(executable)) {
    return undefined;
  }
  if (await hostPathHasExecutable(executable)) {
    return undefined;
  }
  return (await probeDefaultShell(executable)).resolvedPath;
}

/**
 * Ask the default terminal shell whether it can run the executable and where
 * the file lives. Hits are cached for the session; misses only briefly, so
 * installing a provider mid-session is picked up without a reload.
 */
async function probeDefaultShell(
  executable: string
): Promise<ShellResolution> {
  const probe = shellProbeInvocation(
    vscode.env.shell || process.env.SHELL,
    executable
  );
  if (!probe) {
    return { runnable: false };
  }
  const key = `${probe.command} ${executable}`;
  const cached = shellProbeResults.get(key);
  if (cached && (cached.value.runnable || Date.now() < cached.expires)) {
    return cached.value;
  }
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(
      probe.command,
      [...probe.args],
      { encoding: 'utf8', timeout: SHELL_PROBE_TIMEOUT_MS, windowsHide: true },
      (error, output) => resolve(error ? undefined : String(output))
    );
  });
  const candidate =
    stdout === undefined ? undefined : resolvedPathFromProbeOutput(stdout);
  let resolvedPath: string | undefined;
  if (candidate) {
    try {
      await access(candidate);
      resolvedPath = candidate;
    } catch {
      resolvedPath = undefined;
    }
  }
  const value: ShellResolution = {
    runnable: stdout !== undefined,
    ...(resolvedPath ? { resolvedPath } : {})
  };
  shellProbeResults.set(key, {
    value,
    expires: Date.now() + SHELL_PROBE_NEGATIVE_TTL_MS
  });
  return value;
}

import * as path from 'node:path';
import { shellQuote } from './agentCommand';

export interface ShellProbeInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Shells whose PATH edits (nvm, the Claude native installer, ~/.local/bin)
 * typically live in interactive rc files, which only `-i` sources. The other
 * known POSIX shells either source their config unconditionally (fish) or put
 * PATH in login profiles, and `-i` without a tty is riskier there.
 */
const INTERACTIVE_RC_SHELLS = new Set(['bash', 'zsh']);

const LOGIN_ONLY_SHELLS = new Set(['sh', 'dash', 'ash', 'ksh', 'fish']);

/**
 * Build the shell invocation that answers "would the integrated terminal
 * resolve this executable?". Launch commands run inside the user's default
 * terminal shell, which sources profile/rc files the extension host never saw,
 * so a plain host-PATH lookup underreports availability. Returns undefined
 * when no safe flag contract is known for the shell (including all Windows
 * shells, where the terminal inherits the host environment unchanged).
 */
export function shellProbeInvocation(
  shell: string | undefined,
  executable: string,
  platform: NodeJS.Platform = process.platform
): ShellProbeInvocation | undefined {
  if (platform === 'win32') {
    return undefined;
  }
  const command = shell?.trim();
  if (!command || !executable) {
    return undefined;
  }
  const base = path.basename(command).toLowerCase();
  const flags = INTERACTIVE_RC_SHELLS.has(base)
    ? ['-l', '-i', '-c']
    : LOGIN_ONLY_SHELLS.has(base)
      ? ['-l', '-c']
      : undefined;
  if (!flags) {
    return undefined;
  }
  return {
    command,
    args: [...flags, `command -v ${shellQuote(executable, 'posix')}`]
  };
}

/**
 * Extract the executable path a `command -v` probe printed. Rc files may emit
 * greeting or version-manager noise before the probe's own output, so only
 * the final line counts, and aliases or shell functions — which print their
 * definition or bare name instead of a path — yield undefined. Probes only
 * run on POSIX platforms, so an absolute path always starts with `/`.
 */
export function resolvedPathFromProbeOutput(
  stdout: string
): string | undefined {
  const line = stdout
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return line?.startsWith('/') ? line : undefined;
}

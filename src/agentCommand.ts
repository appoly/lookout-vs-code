import * as path from 'node:path';

const SHELL_OPERATORS = /[\n;&|<>]/;

export function withCodexTurnNotification(
  command: string,
  helperPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (
    !isDirectAgentCommand(command, 'codex') ||
    hasCodexNotifyOverride(command)
  ) {
    return command;
  }
  const notifyValue = `notify=${JSON.stringify([
    'node',
    helperPath,
    'attention',
    'Codex is waiting for input'
  ])}`;
  return `${command} -c ${shellQuote(notifyValue, platform)}`;
}

export function isDirectAgentCommand(
  command: string,
  executableName: 'claude' | 'codex'
): boolean {
  if (SHELL_OPERATORS.test(command)) {
    return false;
  }
  const firstToken = command
    .trim()
    .split(/\s+/, 1)[0]
    ?.replace(/^['"]|['"]$/g, '');
  if (!firstToken) {
    return false;
  }
  const executable = path.basename(firstToken).toLowerCase();
  const windowsExecutable = path.win32.basename(firstToken).toLowerCase();
  return (
    executable === executableName ||
    windowsExecutable === `${executableName}.exe`
  );
}

export function shellQuote(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasCodexNotifyOverride(command: string): boolean {
  return /(?:^|\s)(?:-c|--config)(?:\s+|=)\s*['"]?notify\s*=/.test(
    command
  );
}

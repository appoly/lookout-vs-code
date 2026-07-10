import * as path from 'node:path';

const SHELL_OPERATORS = /[\n;&|<>]/;

export function withCodexLifecycleIntegration(
  command: string,
  helperPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (!isDirectAgentCommand(command, 'codex')) {
    return command;
  }
  const overrides: string[] = [];
  if (!hasCodexNotifyOverride(command)) {
    overrides.push(
      `notify=${JSON.stringify([
        'node',
        helperPath,
        'foreground-stop',
        'Codex is waiting for input'
      ])}`
    );
  }
  if (!hasCodexHookOverride(command)) {
    overrides.push(
      'features.hooks=true',
      codexHookOverride(
        'UserPromptSubmit',
        hookCommand(helperPath, 'running', 'Codex is working', platform)
      ),
      codexHookOverride(
        'PermissionRequest',
        hookCommand(helperPath, 'attention', 'Codex needs permission', platform)
      ),
      codexHookOverride(
        'SubagentStart',
        hookCommand(helperPath, 'background-start', undefined, platform)
      ),
      codexHookOverride(
        'SubagentStop',
        hookCommand(helperPath, 'background-stop', undefined, platform)
      ),
      codexHookOverride(
        'Stop',
        hookCommand(
          helperPath,
          'foreground-stop',
          'Codex is waiting for input',
          platform
        )
      )
    );
  }
  return overrides.reduce(
    (result, override) =>
      `${result} -c ${shellQuote(override, platform)}`,
    command
  );
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

function hasCodexHookOverride(command: string): boolean {
  return /(?:^|\s)(?:-c|--config)(?:\s+|=)\s*['"]?(?:features\.hooks|hooks\.)/.test(
    command
  );
}

function codexHookOverride(event: string, command: string): string {
  return `hooks.${event}=[{ hooks = [{ type = "command", command = ${JSON.stringify(
    command
  )}, timeout = 10 }] }]`;
}

function hookCommand(
  helperPath: string,
  action: string,
  message: string | undefined,
  platform: NodeJS.Platform
): string {
  return [
    'node',
    shellQuote(helperPath, platform),
    '--hook',
    'codex',
    action,
    ...(message ? [shellQuote(message, platform)] : [])
  ].join(' ');
}

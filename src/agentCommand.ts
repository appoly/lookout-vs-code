import * as path from 'node:path';
import { directCommandExecutable } from './directCommand';

export const PROVIDER_ACTIVITY_TOOL_MATCHER =
  '^(?:Bash|codex_apps\\..+|mcp__.+)$';

/**
 * The shell that will parse a launch command typed into a terminal. Quoting
 * differs enough between them that a single style cannot be correct
 * everywhere; `unknown` means no safe quoting is known and callers must not
 * inject quoted arguments at all. `argv` is not a terminal shell: it quotes
 * for a bare CommandLineToArgvW pass (provider hook runners on Windows).
 */
export type LaunchShell =
  | 'posix'
  | 'cmd'
  | 'powershell'
  | 'windows-powershell'
  | 'argv'
  | 'unknown';

export function classifyShell(
  shellPath: string | undefined,
  _platform: NodeJS.Platform = process.platform
): LaunchShell {
  const trimmed = shellPath?.trim();
  if (!trimmed) {
    return 'unknown';
  }
  const base = path
    .basename(trimmed.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (base === 'cmd') {
    return 'cmd';
  }
  if (base === 'pwsh') {
    // pwsh 7.3+ re-marshals in-memory arguments correctly on Windows and has
    // always passed argv verbatim on POSIX; 7.0–7.2 are end-of-life.
    return 'powershell';
  }
  if (base === 'powershell') {
    return 'windows-powershell';
  }
  if (
    ['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'ash', 'busybox', 'wsl'].includes(
      base
    )
  ) {
    return 'posix';
  }
  return 'unknown';
}

/** The shell a provider uses to run hook command strings it was configured with. */
export function hookRunnerShell(
  platform: NodeJS.Platform = process.platform
): LaunchShell {
  return platform === 'win32' ? 'argv' : 'posix';
}

export function withCodexLifecycleIntegration(
  command: string,
  helperPath: string,
  launchShell: LaunchShell,
  platform: NodeJS.Platform = process.platform
): string {
  if (launchShell === 'unknown' || !isDirectAgentCommand(command, 'codex')) {
    return command;
  }
  const hookShell = hookRunnerShell(platform);
  const overrides: string[] = [];
  if (!hasCodexNotifyOverride(command)) {
    overrides.push(
      `notify=${JSON.stringify([
        'node',
        helperPath,
        'turn-end',
        'Codex finished'
      ])}`
    );
  }
  if (!hasCodexHookOverride(command)) {
    overrides.push(
      'features.hooks=true',
      codexHookOverride(
        'SessionStart',
        hookCommand(helperPath, 'session-start', undefined, hookShell)
      ),
      codexHookOverride(
        'UserPromptSubmit',
        hookCommand(helperPath, 'running', 'Codex is working', hookShell)
      ),
      codexHookOverride(
        'PermissionRequest',
        hookCommand(
          helperPath,
          'running',
          'Codex is checking authorization',
          hookShell
        )
      ),
      codexHookOverride(
        'SubagentStart',
        hookCommand(helperPath, 'background-start', undefined, hookShell)
      ),
      codexHookOverride(
        'SubagentStop',
        hookCommand(helperPath, 'background-stop', undefined, hookShell)
      ),
      // Surface shell commands and MCP calls while they execute. The bridge
      // allow-lists the safe label and drops arguments for non-shell tools.
      codexHookOverride(
        'PreToolUse',
        hookCommand(helperPath, 'command-start', undefined, hookShell),
        PROVIDER_ACTIVITY_TOOL_MATCHER
      ),
      codexHookOverride(
        'PostToolUse',
        hookCommand(helperPath, 'command-stop', undefined, hookShell),
        PROVIDER_ACTIVITY_TOOL_MATCHER
      ),
      codexHookOverride(
        'Stop',
        hookCommand(
          helperPath,
          'turn-end',
          'Codex finished',
          hookShell
        )
      )
    );
  }
  if (launchShell === 'windows-powershell') {
    // The override values embed quotes, which 5.1 cannot marshal; hand the
    // exact argv-encoded text past the parser with the stop-parsing token.
    return `${command}${windowsPowerShellVerbatimSuffix(
      overrides.map((override) => `-c ${shellQuote(override, 'argv')}`).join(' ')
    )}`;
  }
  return overrides.reduce(
    (result, override) =>
      `${result} -c ${shellQuote(override, launchShell)}`,
    command
  );
}

export function withCodexTokenBudget(
  command: string,
  limitTokens: number,
  launchShell: LaunchShell
): string {
  const limit = Math.floor(limitTokens);
  if (
    limit <= 0 ||
    !isDirectAgentCommand(command, 'codex') ||
    hasCodexRolloutBudgetOverride(command)
  ) {
    return command;
  }
  const overrides = [
    'features.rollout_budget.enabled=true',
    `features.rollout_budget.limit_tokens=${limit}`,
    // Current Codex builds require this field whenever rollout_budget is
    // enabled. An empty list keeps Lookout from inventing reminder thresholds
    // while retaining Codex's initial budget notice and hard limit.
    'features.rollout_budget.reminder_at_remaining_tokens=[]'
  ];
  return overrides.reduce(
    (result, override) =>
      `${result} -c ${
        launchShell === 'unknown' ? override : shellQuote(override, launchShell)
      }`,
    command
  );
}

export function isDirectAgentCommand(
  command: string,
  executableName: 'claude' | 'codex'
): boolean {
  const firstToken = directCommandExecutable(command);
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

export function shellQuote(value: string, shell: LaunchShell): string {
  switch (shell) {
    case 'argv':
      // A bare CommandLineToArgvW consumer (no shell in between).
      return `"${escapeForCommandLineToArgv(value)}"`;
    case 'cmd':
      // cmd rewrites the typed line before the target parses it with
      // CommandLineToArgvW, and the two disagree about quote regions. Caret-
      // escaping every cmd metacharacter — including the quotes — keeps cmd
      // from ever entering quoted mode, so it strips the carets and hands the
      // argv-escaped token through byte-for-byte (the cross-spawn approach).
      return `"${escapeForCommandLineToArgv(value)}"`.replace(
        /[()%!^"<>&|]/g,
        '^$&'
      );
    case 'powershell':
      // pwsh 7.3+ re-marshals its in-memory argument correctly on Windows and
      // has always passed argv verbatim on POSIX. A single-quoted literal also
      // avoids `$` interpolation. Values with embedded quotes must go through
      // windowsPowerShellVerbatimSuffix on 5.1, not here.
      return `'${value.replace(/'/g, "''")}'`;
    case 'windows-powershell':
      // Safe only for values WITHOUT embedded quotes: PowerShell 5.1 passes a
      // quote-wrapped, space-containing in-memory argument verbatim (verified
      // against the real shell), but mangles arguments whose interior contains
      // quotes. Quote-bearing values must use windowsPowerShellVerbatimSuffix.
      return `'${`"${escapeForCommandLineToArgv(value)}"`.replace(/'/g, "''")}'`;
    case 'posix':
      return `'${value.replace(/'/g, `'\\''`)}'`;
    case 'unknown':
      // Only reached for values without embedded quotes or spaces worth
      // protecting; injection paths that need fidelity skip unknown shells.
      return `"${value.replace(/"/g, '""')}"`;
  }
}

/**
 * Windows PowerShell 5.1 cannot reliably marshal arguments that contain both
 * quotes and spaces, but its stop-parsing token `--%` passes the remainder of
 * the line into the native command line verbatim. Callers append this AFTER
 * the user's own arguments so those still get normal PowerShell treatment.
 */
function windowsPowerShellVerbatimSuffix(quotedArguments: string): string {
  return ` --% ${quotedArguments}`;
}

function escapeForCommandLineToArgv(value: string): string {
  return value.replace(
    /(\\*)"/g,
    (_match, backslashes: string) => `${backslashes}${backslashes}\\"`
  );
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

function hasCodexRolloutBudgetOverride(command: string): boolean {
  return /(?:^|\s)(?:-c|--config)(?:\s+|=)\s*['"]?features\.rollout_budget\./.test(
    command
  );
}

function codexHookOverride(
  event: string,
  command: string,
  matcher?: string
): string {
  const matcherField = matcher ? `matcher = ${JSON.stringify(matcher)}, ` : '';
  return `hooks.${event}=[{ ${matcherField}hooks = [{ type = "command", command = ${JSON.stringify(
    command
  )}, timeout = 10 }] }]`;
}

function hookCommand(
  helperPath: string,
  action: string,
  message: string | undefined,
  hookShell: LaunchShell
): string {
  return [
    'node',
    shellQuote(helperPath, hookShell),
    '--hook',
    'codex',
    action,
    ...(message ? [shellQuote(message, hookShell)] : [])
  ].join(' ');
}

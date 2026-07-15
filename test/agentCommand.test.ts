import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyShell,
  isDirectAgentCommand,
  shellQuote,
  withCodexLifecycleIntegration,
  withCodexTokenBudget
} from '../src/agentCommand';

test('adds session-only Codex turn and delegated-agent lifecycle events', () => {
  const command = withCodexLifecycleIntegration(
    'codex --no-alt-screen',
    '/extension/notify.js',
    'posix',
    'linux'
  );
  assert.match(command, /notify=.*turn-end/);
  assert.match(command, /features\.hooks=true/);
  assert.match(command, /hooks\.Stop=.*--hook codex turn-end/);
  assert.match(command, /hooks\.UserPromptSubmit=/);
  assert.match(command, /hooks\.SessionStart=/);
  assert.match(command, /hooks\.PermissionRequest=/);
  assert.match(
    command,
    /hooks\.PermissionRequest=.*--hook codex running.*Codex is checking authorization/
  );
  assert.doesNotMatch(
    command,
    /hooks\.PermissionRequest=.*--hook codex attention/
  );
  assert.match(command, /hooks\.SubagentStart=/);
  assert.match(command, /hooks\.SubagentStop=/);
  assert.match(command, /hooks\.Stop=/);
  assert.match(command, /--hook codex background-start/);
  assert.match(
    command,
    /hooks\.PreToolUse=.*--hook codex command-start/
  );
  assert.match(
    command,
    /hooks\.PostToolUse=.*--hook codex command-stop/
  );
  assert.match(command, /codex_apps/);
  assert.match(command, /mcp__/);
});

test('adds a native Codex rollout token budget without replacing user overrides', () => {
  const command = withCodexTokenBudget('codex --no-alt-screen', 50_000, 'posix');
  assert.match(command, /features\.rollout_budget\.enabled=true/);
  assert.match(command, /features\.rollout_budget\.limit_tokens=50000/);
  assert.match(
    command,
    /features\.rollout_budget\.reminder_at_remaining_tokens=\[\]/
  );

  const explicit =
    "codex -c 'features.rollout_budget.limit_tokens=1234'";
  assert.equal(withCodexTokenBudget(explicit, 50_000, 'posix'), explicit);
  assert.equal(withCodexTokenBudget('wrapper codex', 50_000, 'posix'), 'wrapper codex');
});

test('preserves explicit Codex notifier and hook overrides', () => {
  const explicitNotifier = withCodexLifecycleIntegration(
    "codex -c 'notify=[\"my-notifier\"]'",
    '/extension/notify.js',
    'posix',
    'linux'
  );
  assert.doesNotMatch(explicitNotifier, /Lookout is waiting/);
  assert.match(explicitNotifier, /hooks\.SubagentStart=/);

  const explicitHooks = withCodexLifecycleIntegration(
    "codex -c 'hooks.Stop=[]'",
    '/extension/notify.js',
    'posix',
    'linux'
  );
  assert.match(explicitHooks, /notify=/);
  assert.doesNotMatch(explicitHooks, /hooks\.SubagentStart=/);

  assert.equal(
    withCodexLifecycleIntegration(
      'wrapper codex',
      '/extension/notify.js',
      'posix',
      'linux'
    ),
    'wrapper codex'
  );
});

test('recognizes direct provider commands without accepting shell expressions', () => {
  assert.equal(isDirectAgentCommand('/usr/bin/codex resume', 'codex'), true);
  assert.equal(
    isDirectAgentCommand('"C:\\Program Files\\codex.exe" resume', 'codex'),
    true
  );
  assert.equal(isDirectAgentCommand('claude --model opus', 'claude'), true);
  assert.equal(isDirectAgentCommand('codex && echo done', 'codex'), false);
  assert.equal(isDirectAgentCommand('codex $(pwd)', 'codex'), false);
  assert.equal(isDirectAgentCommand('codex `pwd`', 'codex'), false);
  assert.equal(isDirectAgentCommand('"codex.exe"suffix', 'codex'), false);
  assert.equal(shellQuote("it's ready", 'posix'), "'it'\\''s ready'");
});

test('classifies terminal shells from their executable paths', () => {
  assert.equal(classifyShell('/bin/bash', 'linux'), 'posix');
  assert.equal(classifyShell('/usr/local/bin/fish', 'darwin'), 'posix');
  assert.equal(
    classifyShell('C:\\Windows\\System32\\cmd.exe', 'win32'),
    'cmd'
  );
  assert.equal(
    classifyShell(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'win32'
    ),
    'windows-powershell'
  );
  assert.equal(
    classifyShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'),
    'powershell'
  );
  assert.equal(classifyShell('/usr/bin/pwsh', 'linux'), 'powershell');
  assert.equal(
    classifyShell('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'),
    'posix'
  );
  assert.equal(classifyShell('C:\\tools\\nu.exe', 'win32'), 'unknown');
  assert.equal(classifyShell('/usr/bin/nu', 'linux'), 'unknown');
  assert.equal(classifyShell('/usr/bin/elvish', 'linux'), 'unknown');
  assert.equal(classifyShell(undefined, 'win32'), 'unknown');
  assert.equal(classifyShell(undefined, 'linux'), 'unknown');
});

test('skips Codex hook injection when the launch shell is unknown', () => {
  assert.equal(
    withCodexLifecycleIntegration(
      'codex',
      'C:\\Users\\Appoly User\\ext\\notify.js',
      'unknown',
      'win32'
    ),
    'codex'
  );
});

// The heart of the win32 fix: every quoted -c value must survive the round
// trip through the shell that parses the typed command line and the
// CommandLineToArgvW pass in the launched codex.exe.

const WINDOWS_HELPER = 'C:\\Users\\Appoly User\\.vscode\\ext\\notify.js';

function windowsCommand(shell: 'powershell' | 'windows-powershell' | 'cmd'): string {
  const command = withCodexLifecycleIntegration(
    'codex',
    WINDOWS_HELPER,
    shell,
    'win32'
  );
  assert.notEqual(command, 'codex');
  return command;
}

function windowsCommandOverrides(shell: 'powershell' | 'cmd'): string[] {
  // Overrides are appended as ` -c <quoted>`; recover the quoted values.
  const parts = windowsCommand(shell).split(' -c ');
  parts.shift();
  assert.ok(parts.length >= 8);
  return parts;
}

/** CommandLineToArgvW quote/backslash rules (post-2008 '""' rule included). */
function parseWindowsCommandLineArg(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let sawAny = false;
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (char === '\\') {
      let backslashes = 0;
      while (input[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (input[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
          index += 1;
        }
      } else {
        current += '\\'.repeat(backslashes);
      }
      sawAny = true;
      continue;
    }
    if (char === '"') {
      if (inQuotes && input[index + 1] === '"') {
        current += '"';
        index += 2;
        continue;
      }
      inQuotes = !inQuotes;
      sawAny = true;
      index += 1;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (sawAny || current.length > 0) {
        tokens.push(current);
        current = '';
        sawAny = false;
      }
      index += 1;
      continue;
    }
    current += char;
    sawAny = true;
    index += 1;
  }
  if (sawAny || current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/** How PowerShell parses a single-quoted literal into an in-memory string. */
function parsePowerShellSingleQuoted(literal: string): string {
  assert.ok(literal.startsWith("'") && literal.endsWith("'"));
  return literal.slice(1, -1).replace(/''/g, "'");
}

test('windows-powershell injection rides the verbatim --% stop-parsing token', () => {
  const command = windowsCommand('windows-powershell');
  const marker = ' --% ';
  const markerIndex = command.indexOf(marker);
  assert.ok(markerIndex > 0, 'must use the stop-parsing token');
  assert.equal(command.slice(0, markerIndex), 'codex');
  // PowerShell (5.1 and 7) passes everything after --% into the native
  // command line verbatim, so CommandLineToArgvW sees exactly these bytes.
  const nativeTail = command.slice(markerIndex + marker.length);
  assert.doesNotMatch(nativeTail, /%\w+%/, 'no cmd-style env expansions');
  const argv = parseWindowsCommandLineArg(nativeTail);
  const expected = rawOverrideValues().flatMap((value) => ['-c', value]);
  assert.deepEqual(argv, expected);
  const stop = argv.find((value) => value.startsWith('hooks.Stop='));
  assert.ok(stop);
  assert.match(
    stop,
    /command = "node \\"C:\\\\Users\\\\Appoly User\\\\\.vscode\\\\ext\\\\notify\.js\\" --hook codex turn-end \\"Codex finished\\""/
  );
});

/**
 * cmd strips a caret before any character outside quoted regions; the caret
 * escaping keeps every quote careted, so cmd never enters a quoted region.
 */
function stripCmdCarets(input: string): string {
  return input.replace(/\^(.)/g, '$1');
}

test('cmd quoting reconstructs the exact override values through CommandLineToArgvW', () => {
  const expected = rawOverrideValues();
  const parsed = windowsCommandOverrides('cmd').map((quoted) => {
    assert.doesNotMatch(quoted, /(^|[^^])["<>&|%!()]/, 'metachars must be careted');
    const argv = parseWindowsCommandLineArg(stripCmdCarets(quoted));
    assert.equal(argv.length, 1, `split into ${JSON.stringify(argv)}`);
    return argv[0];
  });
  assert.deepEqual(parsed, expected);
});

test('pwsh 7.3+ quoting parses to the exact override values in memory', () => {
  const expected = rawOverrideValues();
  const parsed = windowsCommandOverrides('powershell').map((quoted) =>
    parsePowerShellSingleQuoted(quoted)
  );
  // pwsh 7.3+ marshals the in-memory string to native argv faithfully, so
  // matching the raw value is the whole correctness condition.
  assert.deepEqual(parsed, expected);
});

/** The intended raw -c values, recovered via the POSIX single-quote encoding. */
function rawOverrideValues(): string[] {
  const command = withCodexLifecycleIntegration(
    'codex',
    WINDOWS_HELPER,
    'posix',
    'win32'
  );
  const parts = command.split(' -c ');
  parts.shift();
  return parts.map((quoted) => {
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    return quoted.slice(1, -1).replace(/'\\''/g, "'");
  });
}

test('posix quoting reconstructs the exact override values under sh rules', () => {
  const command = withCodexLifecycleIntegration(
    'codex',
    '/home/user name/ext/notify.js',
    'posix',
    'linux'
  );
  const parts = command.split(' -c ');
  parts.shift();
  for (const quoted of parts) {
    // A POSIX single-quoted string is literal; '\'' splices a quote.
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    const value = quoted
      .slice(1, -1)
      .replace(/'\\''/g, "'");
    assert.match(value, /^(notify=|features\.hooks=|hooks\.)/);
  }
});

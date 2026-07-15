#!/usr/bin/env node
/* global Buffer, process */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

const MAX_LOG_BYTES = 512 * 1024;
const outputDirectory = readOutputDirectory(process.argv.slice(2));
mkdirSync(outputDirectory, { recursive: true });

const checks = [
  commandCheck('codex-version', 'codex', ['--version'], []),
  commandCheck('codex-help', 'codex', ['--help'], [
    /\bresume\b/i,
    /\bfork\b/i,
    /--config|-c,\s*--config/i,
    /hook/i
  ]),
  commandCheck('codex-resume-help', 'codex', ['resume', '--help'], [
    /SESSION_ID/i
  ]),
  commandCheck('codex-fork-help', 'codex', ['fork', '--help'], [
    /SESSION_ID/i
  ]),
  commandCheck('codex-features', 'codex', ['features', 'list'], []),
  commandCheck(
    'codex-rollout-budget-config',
    'codex',
    [
      '-c',
      'features.rollout_budget.enabled=true',
      '-c',
      'features.rollout_budget.limit_tokens=1000',
      '-c',
      'features.rollout_budget.reminder_at_remaining_tokens=[]',
      'features',
      'list'
    ],
    [/^rollout_budget\s+.*\btrue\s*$/im]
  ),
  commandCheck('claude-version', 'claude', ['--version'], []),
  commandCheck('claude-help', 'claude', ['--help'], [
    /--resume/i,
    /--fork-session/i,
    /--settings/i,
    /hook/i
  ])
];

for (const check of checks) {
  writeFileSync(
    path.join(outputDirectory, `${check.name}.log`),
    `${check.output}\n`,
    'utf8'
  );
}

const summary = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  advisory: true,
  passed: checks.every((check) => check.passed),
  checks: checks.map(({ name, passed, exitCode, missingMarkers }) => ({
    name,
    passed,
    exitCode,
    missingMarkers
  }))
};
writeFileSync(
  path.join(outputDirectory, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8'
);

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.passed) {
  process.exitCode = 1;
}

function commandCheck(name, command, args, markers) {
  const invocation = platformInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: unauthenticatedEnvironment(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: MAX_LOG_BYTES
  });
  const raw = [result.stdout, result.stderr, result.error?.message]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\n');
  const output = sanitizeLog(raw);
  const missingMarkers = markers
    .filter((marker) => !marker.test(output))
    .map((marker) => marker.source);
  const exitCode = typeof result.status === 'number' ? result.status : null;
  return {
    name,
    output,
    exitCode,
    missingMarkers,
    passed: exitCode === 0 && missingMarkers.length === 0
  };
}

function platformInvocation(command, args) {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  // npm global executables are .cmd shims on Windows. Every token here is a
  // fixed string controlled by this script, not external input.
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].join(' ')]
  };
}

function unauthenticatedEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CODEX_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN'
  ]) {
    delete environment[name];
  }
  environment.NO_COLOR = '1';
  return environment;
}

function sanitizeLog(value) {
  const ansiSequence = new RegExp(
    `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
    'g'
  );
  let sanitized = value
    .replace(new RegExp(escapeRegExp(process.cwd()), 'gi'), '<WORKSPACE>')
    .replace(new RegExp(escapeRegExp(homedir()), 'gi'), '<HOME>')
    .replace(ansiSequence, '')
    .replace(/\b(?:sk|sess|key)-[A-Za-z0-9_-]{12,}\b/g, '<REDACTED_TOKEN>')
    .replace(
      /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)\s*[=:]\s*\S+/gi,
      '<REDACTED_CREDENTIAL>'
    )
    .replace(/\0/g, '');
  if (Buffer.byteLength(sanitized) > MAX_LOG_BYTES) {
    const marker = '\n<LOG_TRUNCATED>\n';
    sanitized = `${sanitized.slice(0, MAX_LOG_BYTES - marker.length)}${marker}`;
  }
  return sanitized.trim() || '<NO_OUTPUT>';
}

function readOutputDirectory(args) {
  const index = args.indexOf('--output-dir');
  const configured = index >= 0 ? args[index + 1] : undefined;
  return path.resolve(configured || 'artifacts/provider-compat');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

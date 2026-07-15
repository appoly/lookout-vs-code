import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';
import { inspectVsix } from './verify-vsix-contents.mjs';

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url))
);
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
);
const vsixPath = path.join(
  repositoryRoot,
  `${manifest.name}-${manifest.version}.vsix`
);
if (!existsSync(vsixPath)) {
  throw new Error(`VSIX does not exist: ${vsixPath}`);
}
await inspectVsix(vsixPath);

const options = {
  version: process.env.LOOKOUT_VSCODE_VERSION ?? 'stable',
  spawn: { cwd: repositoryRoot }
};
const profileRoot = path.join(
  repositoryRoot,
  '.vscode-test',
  `vsix-profile-${manifest.publisher}.${manifest.name}`
);
rmSync(profileRoot, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
});
const profileArgs = [
  `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
  `--user-data-dir=${path.join(profileRoot, 'user-data')}`
];
const workspaceRoot = path.join(profileRoot, 'workspace');
mkdirSync(path.join(workspaceRoot, '.vscode'), { recursive: true });
writeFileSync(
  path.join(workspaceRoot, '.vscode', 'settings.json'),
  `${JSON.stringify(
    {
      'telemetry.telemetryLevel': 'off',
      'extensions.autoCheckUpdates': false,
      'lookout.attentionSound.enabled': false,
      'lookout.usage.codex.enabled': false,
      'lookout.usage.claude.enabled': false
    },
    undefined,
    2
  )}\n`,
  'utf8'
);
const install = await runVSCodeCommand(
  [...profileArgs, '--install-extension', vsixPath, '--force'],
  options
);
process.stdout.write(install.stdout);
process.stderr.write(install.stderr);

const listed = await runVSCodeCommand(
  [...profileArgs, '--list-extensions', '--show-versions'],
  options
);
process.stdout.write(listed.stdout);
process.stderr.write(listed.stderr);

const expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`;
const installed = listed.stdout
  .split(/\r?\n/)
  .some((line) => line.trim().toLowerCase() === expected.toLowerCase());
if (!installed) {
  throw new Error(`Installed extension list did not contain ${expected}`);
}
await runTests({
  version: options.version,
  extensionDevelopmentPath: path.join(
    repositoryRoot,
    'test',
    'fixtures',
    'vsix-smoke-extension'
  ),
  extensionTestsPath: path.join(
    repositoryRoot,
    'test',
    'fixtures',
    'vsix-smoke-extension',
    'run.cjs'
  ),
  launchArgs: [workspaceRoot, ...profileArgs],
  reuseMachineInstall: true,
  extensionTestsEnv: {
    LOOKOUT_VSIX_SMOKE: '1'
  }
});
console.log(`Verified installed and activated VSIX: ${expected}`);

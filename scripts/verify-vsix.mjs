import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runVSCodeCommand } from '@vscode/test-electron';

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

const options = {
  version: process.env.LOOKOUT_VSCODE_VERSION ?? 'stable',
  spawn: { cwd: repositoryRoot }
};
const profileRoot = path.join(repositoryRoot, '.vscode-test', 'vsix-profile');
const profileArgs = [
  `--extensions-dir=${path.join(profileRoot, 'extensions')}`,
  `--user-data-dir=${path.join(profileRoot, 'user-data')}`
];
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
console.log(`Verified installed VSIX: ${expected}`);

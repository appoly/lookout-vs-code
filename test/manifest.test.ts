import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

interface ManifestCommand {
  readonly command: string;
  readonly enablement?: string;
}

interface Manifest {
  readonly preview?: boolean;
  readonly icon?: string;
  readonly categories?: string[];
  readonly files?: string[];
  readonly contributes?: {
    readonly commands?: ManifestCommand[];
    readonly viewsWelcome?: Array<{ readonly when?: string }>;
  };
}

const repositoryRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
) as Manifest;

test('ships the minimum Marketplace presentation metadata', () => {
  assert.equal(manifest.preview, true);
  assert.equal(manifest.icon, 'resources/icon.png');
  assert.ok(manifest.categories?.includes('AI'));
  assert.ok(manifest.files?.includes('PRIVACY.md'));
  assert.ok(manifest.files?.includes('SECURITY.md'));
  assert.ok(manifest.files?.includes('SUPPORT.md'));

  const icon = readFileSync(path.join(repositoryRoot, manifest.icon));
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(icon.readUInt32BE(16) >= 128, 'Marketplace icon is too narrow');
  assert.ok(icon.readUInt32BE(20) >= 128, 'Marketplace icon is too short');
});

test('disables command-launching contributions outside trusted workspaces', () => {
  const commands = new Map(
    manifest.contributes?.commands?.map((entry) => [entry.command, entry]) ?? []
  );
  for (const command of [
    'lookout.launchAgent',
    'lookout.launchCodex',
    'lookout.launchClaude',
    'lookout.launchCustom',
    'lookout.launchAgentInWorktree',
    'lookout.adoptTerminal',
    'lookout.splitSession',
    'lookout.restartSession',
    'lookout.runTask',
    'lookout.runTestTask',
    'lookout.startDebug'
  ]) {
    assert.equal(
      commands.get(command)?.enablement,
      'isWorkspaceTrusted',
      `${command} must require Workspace Trust in the manifest`
    );
  }

  const welcomeStates = new Set(
    manifest.contributes?.viewsWelcome?.map((entry) => entry.when)
  );
  assert.ok(welcomeStates.has('isWorkspaceTrusted'));
  assert.ok(welcomeStates.has('!isWorkspaceTrusted'));
});

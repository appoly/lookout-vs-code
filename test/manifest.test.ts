import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

interface ManifestCommand {
  readonly command: string;
  readonly enablement?: string;
  readonly icon?: string;
  readonly title?: string;
}

interface ManifestMenuEntry {
  readonly command?: string;
  readonly when?: string;
}

interface Manifest {
  readonly name?: string;
  readonly publisher?: string;
  readonly repository?: { readonly url?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
  readonly preview?: boolean;
  readonly icon?: string;
  readonly categories?: string[];
  readonly files?: string[];
  readonly capabilities?: {
    readonly untrustedWorkspaces?: {
      readonly restrictedConfigurations?: string[];
    };
  };
  readonly contributes?: {
    readonly commands?: ManifestCommand[];
    readonly views?: Record<string, Array<{ readonly id?: string }>>;
    readonly menus?: {
      readonly 'view/title'?: ManifestMenuEntry[];
      readonly 'view/item/context'?: ManifestMenuEntry[];
    };
    readonly viewsWelcome?: Array<{ readonly when?: string }>;
    readonly walkthroughs?: Array<{
      readonly id?: string;
      readonly steps?: Array<{
        readonly id?: string;
        readonly completionEvents?: string[];
        readonly media?: { readonly image?: string; readonly altText?: string };
      }>;
    }>;
    readonly configuration?: {
      readonly properties?: Record<string, { readonly scope?: string; readonly default?: unknown }>;
    };
  };
}

const repositoryRoot = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
) as Manifest;

test('uses the Appoly public and registry identity', () => {
  assert.equal(manifest.publisher, 'appoly');
  assert.equal(manifest.name, 'lookout');
  assert.equal(manifest.repository?.url, 'https://github.com/appoly/lookout-vs-code.git');
  assert.equal(manifest.homepage, 'https://github.com/appoly/lookout-vs-code#readme');
  assert.equal(manifest.bugs?.url, 'https://github.com/appoly/lookout-vs-code/issues');
});

test('ships the minimum Marketplace presentation metadata', () => {
  assert.equal(manifest.preview, true);
  assert.equal(manifest.icon, 'resources/icon.png');
  assert.ok(manifest.categories?.includes('AI'));
  assert.ok(manifest.files?.includes('PRIVACY.md'));
  assert.ok(manifest.files?.includes('SECURITY.md'));
  assert.ok(manifest.files?.includes('SUPPORT.md'));
  assert.ok(manifest.files?.includes('assets/screenshots/**'));

  const icon = readFileSync(path.join(repositoryRoot, manifest.icon));
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG');
  assert.ok(icon.readUInt32BE(16) >= 128, 'Marketplace icon is too narrow');
  assert.ok(icon.readUInt32BE(20) >= 128, 'Marketplace icon is too short');

  for (const screenshot of [
    'lookout-overview.png',
    'usage-limits.png',
    'usage-status.png'
  ]) {
    const image = readFileSync(
      path.join(repositoryRoot, 'assets', 'screenshots', screenshot)
    );
    assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(image.readUInt32BE(16) >= 400, `${screenshot} is too narrow`);
    assert.ok(image.readUInt32BE(20) >= 50, `${screenshot} is too short`);
  }
});

test('shows one Agents settings action that opens all Lookout settings', () => {
  const commands = new Map(
    manifest.contributes?.commands?.map((entry) => [entry.command, entry]) ?? []
  );
  const settingsActions =
    manifest.contributes?.menus?.['view/title']?.filter(
      (entry) =>
        entry.when?.includes('view == lookout.sessions') &&
        entry.command &&
        commands.get(entry.command)?.icon === '$(settings-gear)'
    ) ?? [];

  assert.deepEqual(
    settingsActions.map((entry) => entry.command),
    ['lookout.openSettings']
  );
  assert.equal(commands.get('lookout.openSettings')?.title, 'Open Lookout Settings');
});

test('keeps live windows and contextual launch actions in Agents', () => {
  const viewIds = manifest.contributes?.views?.lookout?.map((view) => view.id) ?? [];
  assert.ok(viewIds.includes('lookout.sessions'));
  assert.equal(viewIds.includes('lookout.history'), false);

  const titleActions = manifest.contributes?.menus?.['view/title'] ?? [];
  assert.equal(
    titleActions.some((entry) => entry.command === 'lookout.launchAgentInWorktree'),
    false
  );
  assert.match(
    titleActions.find((entry) => entry.command === 'lookout.launchTemplate')?.when ?? '',
    /lookout\.hasTemplates/
  );

  const remoteAction = manifest.contributes?.menus?.['view/item/context']?.find(
    (entry) => entry.command === 'lookout.focusRemoteSession'
  );
  assert.match(remoteAction?.when ?? '', /view == lookout\.sessions/);
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
    'lookout.launchTemplate',
    'lookout.adoptTerminal',
    'lookout.splitSession',
    'lookout.restartSession',
    'lookout.resumeSession',
    'lookout.forkSession',
    'lookout.resumeGlobalSession',
    'lookout.forkGlobalSession',
    'lookout.runTask',
    'lookout.runTestTask',
    'lookout.runVerification',
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

test('keeps command-output capture globally opt-in', () => {
  const setting = manifest.contributes?.configuration?.properties?.[
    'lookout.review.captureCommandOutput'
  ];
  assert.equal(setting?.default, false);
  assert.equal(setting?.scope, 'application');
});

test('launches agents in the native terminal panel by default', () => {
  const setting = manifest.contributes?.configuration?.properties?.[
    'lookout.terminals.location'
  ];
  assert.equal(setting?.default, 'panel');
});

test('restricts workspace-controlled review scans outside trusted workspaces', () => {
  const restricted = new Set(
    manifest.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []
  );
  for (const setting of [
    'lookout.review.showRecentImages',
    'lookout.review.imageGlob',
    'lookout.review.artifactGlobs'
  ]) {
    assert.ok(restricted.has(setting), `${setting} must be restricted`);
  }
});

test('keeps per-agent token budgets opt-in', () => {
  const properties = manifest.contributes?.configuration?.properties;
  assert.equal(properties?.['lookout.usage.codex.tokenBudget']?.default, 0);
  assert.equal(
    properties?.['lookout.usage.claude.contextWarningTokens']?.default,
    0
  );
});

test('ships a passive getting-started walkthrough', () => {
  const walkthrough = manifest.contributes?.walkthroughs?.find(
    (candidate) => candidate.id === 'lookout.gettingStarted'
  );
  assert.ok(walkthrough);
  assert.ok((walkthrough.steps?.length ?? 0) >= 4);
  for (const step of walkthrough.steps ?? []) {
    assert.ok(
      (step.completionEvents?.length ?? 0) > 0,
      `${step.id} has no completion event`
    );
    assert.match(step.media?.image ?? '', /^assets\/screenshots\//);
    assert.ok((step.media?.altText?.length ?? 0) > 10);
  }
});

test('ships host-local history with experimental live coordination off by default', () => {
  const properties = manifest.contributes?.configuration?.properties;
  assert.equal(properties?.['lookout.history.globalEnabled']?.default, true);
  assert.equal(
    properties?.['lookout.history.globalEnabled']?.scope,
    'application'
  );
  assert.equal(
    properties?.['lookout.experimental.crossWindowCoordination']?.default,
    false
  );
  assert.equal(
    properties?.['lookout.experimental.crossWindowCoordination']?.scope,
    'application'
  );
});

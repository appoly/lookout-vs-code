import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repositoryRoot, 'scripts', 'release-artifact.mjs');
const commit = '0123456789abcdef0123456789abcdef01234567';
const extensionId = 'appoly.lookout';

function fixture(): {
  readonly root: string;
  readonly manifest: string;
  readonly source: string;
  readonly output: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'lookout-release-'));
  const manifest = path.join(root, 'package.json');
  const source = path.join(root, 'lookout-1.2.3.vsix');
  const output = path.join(root, 'artifact');
  writeFileSync(
    manifest,
    JSON.stringify({ name: 'lookout', version: '1.2.3', publisher: 'appoly' })
  );
  writeFileSync(source, 'exact-vsix-bytes');
  return { root, manifest, source, output };
}

function run(...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  });
}

test('prepares and independently verifies an exact release artifact', () => {
  const candidate = fixture();
  const githubOutput = path.join(candidate.root, 'github-output.txt');
  const prepared = run(
    'prepare',
    '--manifest',
    candidate.manifest,
    '--source',
    candidate.source,
    '--output',
    candidate.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    extensionId,
    '--github-output',
    githubOutput
  );
  assert.equal(prepared.status, 0, prepared.stderr);

  const verified = run(
    'verify',
    '--manifest',
    candidate.manifest,
    '--directory',
    candidate.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    extensionId
  );
  assert.equal(verified.status, 0, verified.stderr);
  const metadata = JSON.parse(
    readFileSync(path.join(candidate.output, 'release-metadata.json'), 'utf8')
  ) as { extensionId: string; file: string; tag: string; sha256: string };
  assert.equal(metadata.extensionId, 'appoly.lookout');
  assert.equal(metadata.file, 'lookout-1.2.3.vsix');
  assert.equal(metadata.tag, 'v1.2.3');
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.match(readFileSync(githubOutput, 'utf8'), /artifact_name=lookout-v1\.2\.3-/);
});

test('rejects a release tag that differs from the manifest version', () => {
  const candidate = fixture();
  const result = run(
    'prepare',
    '--manifest',
    candidate.manifest,
    '--source',
    candidate.source,
    '--output',
    candidate.output,
    '--tag',
    'v1.2.4',
    '--commit',
    commit,
    '--extension-id',
    extensionId
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match v1\.2\.3/);
});

test('rejects changed bytes and unexpected files after preparation', () => {
  const changed = fixture();
  assert.equal(
    run(
      'prepare',
      '--manifest',
      changed.manifest,
      '--source',
      changed.source,
      '--output',
      changed.output,
      '--tag',
      'v1.2.3',
      '--commit',
      commit,
      '--extension-id',
      extensionId
    ).status,
    0
  );
  writeFileSync(path.join(changed.output, 'lookout-1.2.3.vsix'), 'changed');
  const changedResult = run(
    'verify',
    '--manifest',
    changed.manifest,
    '--directory',
    changed.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    extensionId
  );
  assert.notEqual(changedResult.status, 0);
  assert.match(changedResult.stderr, /SHA-256 mismatch/);

  const extra = fixture();
  assert.equal(
    run(
      'prepare',
      '--manifest',
      extra.manifest,
      '--source',
      extra.source,
      '--output',
      extra.output,
      '--tag',
      'v1.2.3',
      '--commit',
      commit,
      '--extension-id',
      extensionId
    ).status,
    0
  );
  writeFileSync(path.join(extra.output, 'unexpected.txt'), 'no');
  const extraResult = run(
    'verify',
    '--manifest',
    extra.manifest,
    '--directory',
    extra.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    extensionId
  );
  assert.notEqual(extraResult.status, 0);
  assert.match(extraResult.stderr, /unexpected files/);
});

test('verification binds the artifact to manifest, tag, commit, and extension', () => {
  const candidate = fixture();
  assert.equal(
    run(
      'prepare',
      '--manifest',
      candidate.manifest,
      '--source',
      candidate.source,
      '--output',
      candidate.output,
      '--tag',
      'v1.2.3',
      '--commit',
      commit,
      '--extension-id',
      extensionId
    ).status,
    0
  );

  const wrongTag = run(
    'verify',
    '--manifest',
    candidate.manifest,
    '--directory',
    candidate.output,
    '--tag',
    'v1.2.4',
    '--commit',
    commit,
    '--extension-id',
    extensionId
  );
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.stderr, /does not match v1\.2\.3/);

  const wrongCommit = run(
    'verify',
    '--manifest',
    candidate.manifest,
    '--directory',
    candidate.output,
    '--tag',
    'v1.2.3',
    '--commit',
    'ffffffffffffffffffffffffffffffffffffffff',
    '--extension-id',
    extensionId
  );
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /metadata identity does not match/);

  const wrongExtension = run(
    'verify',
    '--manifest',
    candidate.manifest,
    '--directory',
    candidate.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    'other.lookout'
  );
  assert.notEqual(wrongExtension.status, 0);
  assert.match(wrongExtension.stderr, /does not match appoly\.lookout/);

  const otherManifest = path.join(candidate.root, 'other-package.json');
  writeFileSync(
    otherManifest,
    JSON.stringify({ name: 'other', version: '1.2.3', publisher: 'appoly' })
  );
  const wrongManifest = run(
    'verify',
    '--manifest',
    otherManifest,
    '--directory',
    candidate.output,
    '--tag',
    'v1.2.3',
    '--commit',
    commit,
    '--extension-id',
    'appoly.other'
  );
  assert.notEqual(wrongManifest.status, 0);
  assert.match(wrongManifest.stderr, /metadata identity does not match/);
});

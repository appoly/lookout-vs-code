import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const workflow = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);
const allWorkflows = readdirSync(path.join(repositoryRoot, '.github', 'workflows'))
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => readFileSync(path.join(repositoryRoot, '.github', 'workflows', file), 'utf8'))
  .join('\n');

test('release workflow packages once and promotes the artifact by ID', () => {
  assert.equal((workflow.match(/run: npm run vsix\s*$/gm) ?? []).length, 1);
  assert.doesNotMatch(workflow, /run: npm run verify:vsix\s*$/m);
  assert.match(workflow, /artifact-ids:.*needs\.build-artifact\.outputs\.artifact-id/);
  assert.equal((workflow.match(/release-artifact\.mjs verify/g) ?? []).length, 2);
  assert.match(workflow, /compression-level: 0/);
  assert.match(workflow, /npm run verify:vsix-contents/);
  assert.doesNotMatch(workflow, /vsce ls/);
});

test('registry publication is manual, explicit, and environment gated', () => {
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && inputs\.publish_marketplace/
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && inputs\.publish_open_vsx/
  );
  assert.match(workflow, /name: visual-studio-marketplace/);
  assert.match(workflow, /name: open-vsx/);
  assert.match(workflow, /client-id:.*vars\.AZURE_CLIENT_ID/);
  assert.match(workflow, /tenant-id:.*vars\.AZURE_TENANT_ID/);
  assert.match(workflow, /OVSX_PAT:.*secrets\.OVSX_PAT/);
  assert.doesNotMatch(workflow, /VSCE_PAT/);
});

test('publisher clients receive a verified package path and cannot package implicitly', () => {
  assert.match(
    workflow,
    /vsce publish[\s\S]*--azure-credential[\s\S]*--packagePath.*steps\.verify\.outputs\.vsix_path/
  );
  assert.match(
    workflow,
    /node_modules\/ovsx\/bin\/ovsx publish[\s\S]*--packagePath.*steps\.verify\.outputs\.vsix_path/
  );
  assert.doesNotMatch(workflow, /npx\s+--yes/);
});

test('third-party actions are pinned to full commit SHAs', () => {
  const actionReferences = [...allWorkflows.matchAll(/uses:\s+([^\s#]+)/g)].map(
    (match) => match[1]
  );
  assert.ok(actionReferences.length > 0);
  for (const reference of actionReferences) {
    assert.match(reference, /@[a-f0-9]{40}$/i, `${reference} is not SHA-pinned`);
  }
});

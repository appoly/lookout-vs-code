import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const extensionSource = readFileSync(
  path.join(repositoryRoot, 'src', 'extension.ts'),
  'utf8'
);
const reviewTreeSource = readFileSync(
  path.join(repositoryRoot, 'src', 'reviewTree.ts'),
  'utf8'
);

// A freshly created tree view reports visible === false until it renders, so the
// render event is the only signal that the Review view is on screen. If that
// event lands before its listener is attached it is lost for good, and the view
// stays empty and unpolled until the user manually switches containers. These
// are ordering invariants that read as harmless to rearrange, so guard them.

test('the review view subscribes to visibility before sampling or awaiting', () => {
  const createIndex = extensionSource.indexOf(
    "createTreeView('lookout.review'"
  );
  assert.ok(createIndex > 0, 'the review tree view must be created');

  const subscribeIndex = extensionSource.indexOf(
    'onDidChangeVisibility',
    createIndex
  );
  assert.ok(
    subscribeIndex > createIndex,
    'the visibility subscription must follow view creation'
  );

  const sampleIndex = extensionSource.indexOf(
    'setVisible(reviewTreeView.visible)',
    createIndex
  );
  assert.ok(
    sampleIndex > subscribeIndex,
    'sampling .visible must not precede the visibility subscription'
  );

  const awaitIndex = extensionSource.indexOf('await ', createIndex);
  assert.ok(
    awaitIndex > subscribeIndex,
    'no await may separate view creation from the visibility subscription'
  );
});

test('first review population does not depend on one visibility event', () => {
  assert.ok(
    reviewTreeSource.includes('private ensurePopulated()'),
    'reviewTree must expose a single-shot population guard'
  );

  const getChildrenIndex = reviewTreeSource.indexOf('public getChildren(');
  assert.ok(getChildrenIndex > 0, 'reviewTree must implement getChildren');

  const ensureIndex = reviewTreeSource.indexOf(
    'this.ensurePopulated()',
    getChildrenIndex
  );
  assert.ok(
    ensureIndex > getChildrenIndex && ensureIndex - getChildrenIndex < 400,
    'getChildren must populate on first render, since rendering is the one ' +
      'signal that cannot be missed'
  );
});

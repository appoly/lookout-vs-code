import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactTypeLabel,
  classifyArtifact
} from '../src/artifactClassification';

test('classifies Workshop artifacts by canonical path', () => {
  assert.equal(classifyArtifact('docs/research/context/limits.md'), 'research');
  assert.equal(classifyArtifact('docs/brainstorms/navigation.md'), 'brainstorm');
  assert.equal(classifyArtifact('docs/plans/cockpit.md'), 'plan');
  assert.equal(classifyArtifact('plans/legacy.md'), 'plan');
  assert.equal(classifyArtifact('docs/fleet/release.md'), 'fleet');
  assert.equal(classifyArtifact('docs/solutions/attention.md'), 'solution');
  assert.equal(classifyArtifact('docs/changelog.md'), 'changelog');
  assert.equal(classifyArtifact('todos/follow-up.md'), 'todo');
  assert.equal(classifyArtifact('TODOS.md'), 'todo');
  assert.equal(classifyArtifact('DESIGN.md'), 'design');
  assert.equal(classifyArtifact('docs/architecture.md'), 'docs');
  assert.equal(artifactTypeLabel(classifyArtifact('docs/plans/a.md')), 'plan');
});

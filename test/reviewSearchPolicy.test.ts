import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedReviewItemLimit,
  normalizeReviewGlobs,
  reviewSearchResultLimit
} from '../src/reviewSearchPolicy';

test('bounds and validates workspace-controlled review globs', () => {
  const configured = [
    '**/*.md',
    '**/*.md',
    '../**/*',
    'C:\\**\\*',
    '/tmp/**/*',
    '',
    ...Array.from({ length: 30 }, (_, index) => `docs/${index}/**/*`)
  ];
  const normalized = normalizeReviewGlobs(configured, ['fallback/**/*']);

  assert.equal(normalized[0], '**/*.md');
  assert.equal(normalized.length, 16);
  assert.equal(normalized.some((glob) => glob.includes('..')), false);
  assert.equal(normalized.some((glob) => pathLooksAbsolute(glob)), false);
});

test('uses safe defaults and clamps scan result limits', () => {
  assert.deepEqual(normalizeReviewGlobs(undefined, ['docs/**/*.md']), [
    'docs/**/*.md'
  ]);
  assert.equal(boundedReviewItemLimit(Number.POSITIVE_INFINITY), 12);
  assert.equal(boundedReviewItemLimit(-50), 1);
  assert.equal(boundedReviewItemLimit(5.9), 5);
  assert.equal(reviewSearchResultLimit(1_000), 800);
});

function pathLooksAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

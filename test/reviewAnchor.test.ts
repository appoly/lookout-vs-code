import assert from 'node:assert/strict';
import test from 'node:test';

import { anchoredSessions } from '../src/reviewAnchor';
import type { AgentSession } from '../src/types';

function session(
  id: string,
  createdAt: number,
  branch: string
): AgentSession {
  return {
    id,
    label: id,
    kind: 'claude',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    cwd: '/repo',
    baseline: {
      repoRoot: '/repo',
      commit: `${id}-commit`,
      branch,
      capturedAt: createdAt
    }
  } as unknown as AgentSession;
}

const closedLastWeek = session('closed-last-week', 1_000, 'main');
const openToday = session('open-today', 5_000, 'feature');
const openLater = session('open-later', 6_000, 'feature');
const sorted = [closedLastWeek, openToday, openLater];
const isOpen = (id: string): boolean => id !== 'closed-last-week';

test('a closed session never anchors a context that has open sessions', () => {
  const anchored = anchoredSessions(sorted, isOpen);

  assert.equal(
    anchored[0]?.id,
    'open-today',
    'the earliest OPEN session must anchor the context'
  );
  assert.equal(
    anchored[0]?.baseline?.branch,
    'feature',
    'the baseline branch must come from a live session, not dead history'
  );
  assert.ok(
    !anchored.some((entry) => entry.id === 'closed-last-week'),
    'a closed session must not be reported as attached'
  );
});

test('the earliest open session anchors, keeping reviewed changes stable', () => {
  // Attaching a newer session must not move the anchor, or already-reviewed
  // changes would disappear from the group.
  assert.equal(anchoredSessions([openToday, openLater], isOpen)[0]?.id, 'open-today');
  assert.equal(anchoredSessions([openLater], isOpen)[0]?.id, 'open-later');
});

test('a context with nothing open still renders rather than vanishing', () => {
  const anchored = anchoredSessions(sorted, () => false);

  assert.equal(anchored.length, 3, 'the full list is the teardown fallback');
  assert.equal(anchored[0]?.id, 'closed-last-week');
});

test('an empty context yields no anchor', () => {
  assert.deepEqual(anchoredSessions([], isOpen), []);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { safeEventPresentation } from '../src/sessionEventPresentation';
import type { SessionEvent } from '../src/sessionEvents';

test('uses fixed safe event summaries and never renders stored payload text', () => {
  const unsafe: SessionEvent = {
    id: 'unsafe',
    sessionId: 'a',
    sequence: 1,
    kind: 'command-finished',
    observedAt: 1_000,
    source: 'provider-hook',
    summary: 'SECRET command output and transcript text',
    attention: 'notice',
    correlationId: 'SECRET-correlation',
    providerSessionId: 'SECRET-provider-id',
    outcome: 'failed'
  };

  const presentation = safeEventPresentation(unsafe);
  assert.deepEqual(presentation, {
    label: 'Agent command finished',
    detail: 'Failed · Provider hook'
  });
  assert.equal(JSON.stringify(presentation).includes('SECRET'), false);
});

test('omits the outcome segment when the event has none', () => {
  const presentation = safeEventPresentation({
    kind: 'provider-attention',
    source: 'provider-hook'
  });
  assert.deepEqual(presentation, {
    label: 'Agent needs attention',
    detail: 'Provider hook'
  });
});

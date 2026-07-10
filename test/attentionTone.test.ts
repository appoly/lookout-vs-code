import assert from 'node:assert/strict';
import test from 'node:test';
import { createAttentionBellWav } from '../src/attentionTone';

test('creates a volume-scaled PCM bell WAV', () => {
  const quiet = createAttentionBellWav(10);
  const loud = createAttentionBellWav(80);
  assert.equal(loud.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(loud.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(loud.readUInt32LE(24), 44_100);
  assert.equal(loud.length, quiet.length);
  assert.ok(maxSample(loud) > maxSample(quiet) * 4);
});

function maxSample(buffer: Buffer): number {
  let maximum = 0;
  for (let offset = 44; offset < buffer.length; offset += 2) {
    maximum = Math.max(maximum, Math.abs(buffer.readInt16LE(offset)));
  }
  return maximum;
}

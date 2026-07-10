const SAMPLE_RATE = 44_100;
const DURATION_SECONDS = 0.75;

export function createAttentionBellWav(volumePercent: number): Buffer {
  const volume = Math.max(0, Math.min(100, volumePercent)) / 100;
  const sampleCount = Math.floor(SAMPLE_RATE * DURATION_SECONDS);
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  writeWavHeader(buffer, dataBytes);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / SAMPLE_RATE;
    const attack = Math.min(1, time / 0.004);
    const decay = Math.exp(-4.8 * time);
    const shimmer = 0.68 * Math.sin(2 * Math.PI * 880 * time);
    const overtone = 0.23 * Math.sin(2 * Math.PI * 1_327 * time + 0.35);
    const high = 0.09 * Math.sin(2 * Math.PI * 2_213 * time + 0.8);
    const value = (shimmer + overtone + high) * attack * decay * volume * 0.72;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), 44 + index * 2);
  }
  return buffer;
}

function writeWavHeader(buffer: Buffer, dataBytes: number): void {
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
}

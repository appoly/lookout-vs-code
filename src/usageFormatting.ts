export function formatResetDescription(
  resetsAtSeconds: number | undefined,
  nowMilliseconds = Date.now()
): string {
  if (!resetsAtSeconds) {
    return '';
  }
  const delta = resetsAtSeconds * 1000 - nowMilliseconds;
  if (delta <= 0) {
    return 'reset due';
  }
  let minutes = Math.ceil(delta / 60_000);
  const days = Math.floor(minutes / 1_440);
  minutes %= 1_440;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }
  return `resets in ${parts.join(' ')}`;
}

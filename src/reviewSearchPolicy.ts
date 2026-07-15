import * as path from 'node:path';

const MAX_REVIEW_GLOBS = 16;
const MAX_REVIEW_GLOB_LENGTH = 512;

/** Bound workspace-controlled glob configuration before it reaches VS Code. */
export function normalizeReviewGlobs(
  configured: readonly unknown[] | undefined,
  fallback: readonly string[]
): string[] {
  const values = configured ?? fallback;
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (normalized.length >= MAX_REVIEW_GLOBS || typeof value !== 'string') {
      continue;
    }
    const glob = value.trim();
    if (
      glob.length === 0 ||
      glob.length > MAX_REVIEW_GLOB_LENGTH ||
      glob.includes('\0') ||
      path.posix.isAbsolute(glob) ||
      path.win32.isAbsolute(glob) ||
      glob.includes('..') ||
      seen.has(glob)
    ) {
      continue;
    }
    seen.add(glob);
    normalized.push(glob);
  }

  return normalized;
}

export function boundedReviewItemLimit(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.floor(value)))
    : 12;
}

export function reviewSearchResultLimit(maxItems: number): number {
  return boundedReviewItemLimit(maxItems) * 8;
}

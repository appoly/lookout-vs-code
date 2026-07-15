export interface RuntimeErrorIdentity {
  readonly name: string;
  readonly code?: string;
}

const SAFE_ERROR_TOKEN = /^[A-Z0-9_-]{1,40}$/i;

/** Keep runtime logs metadata-only even when an Error has mutable fields. */
export function runtimeErrorIdentity(error: unknown): RuntimeErrorIdentity {
  const candidateName = error instanceof Error ? error.name : typeof error;
  const name = SAFE_ERROR_TOKEN.test(candidateName) ? candidateName : 'unknown';
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return { name };
  }
  const candidateCode = (error as { readonly code?: unknown }).code;
  return typeof candidateCode === 'string' && SAFE_ERROR_TOKEN.test(candidateCode)
    ? { name, code: candidateCode }
    : { name };
}

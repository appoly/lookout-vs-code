const SHELL_OPERATORS = /[\n;&|<>`$]/;

/**
 * Extract the executable token from a direct command without evaluating shell
 * syntax. Quoted executable paths are accepted only when the closing quote is
 * followed by whitespace or the end of the command.
 */
export function directCommandExecutable(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATORS.test(trimmed)) {
    return undefined;
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end <= 1 || (end + 1 < trimmed.length && !/\s/.test(trimmed[end + 1]))) {
      return undefined;
    }
    return trimmed.slice(1, end);
  }

  const token = /^(\S+)/.exec(trimmed)?.[1];
  return token && !/["']/.test(token) ? token : undefined;
}

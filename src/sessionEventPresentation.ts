import type { SessionEvent, SessionEventKind } from './sessionEvents';

export interface SafeEventPresentation {
  readonly label: string;
  readonly detail: string;
}

/**
 * Event text is derived exclusively from allow-listed enums. `event.summary`,
 * correlation IDs, provider IDs, command text, and provider payloads are never
 * rendered.
 */
export function safeEventPresentation(
  event: Pick<SessionEvent, 'kind' | 'outcome' | 'source'>
): SafeEventPresentation {
  const label = EVENT_LABELS[event.kind];
  const outcome = event.outcome ? outcomeLabel(event.outcome) : undefined;
  return {
    label,
    detail: `${outcome ? `${outcome} · ` : ''}${sourceLabel(event.source)}`
  };
}

function outcomeLabel(outcome: NonNullable<SessionEvent['outcome']>): string {
  switch (outcome) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'unknown':
      return 'Unknown outcome';
  }
}

function sourceLabel(source: SessionEvent['source']): string {
  switch (source) {
    case 'provider-hook':
      return 'Provider hook';
    case 'terminal':
      return 'Terminal';
    case 'git':
      return 'Git';
    case 'task':
      return 'Task';
    case 'debug':
      return 'Debug';
    case 'user':
      return 'User action';
    case 'system':
      return 'Lookout';
  }
}

const EVENT_LABELS: Readonly<Record<SessionEventKind, string>> = {
  'session-created': 'Session created',
  'session-adopted': 'Terminal adopted',
  'session-focused': 'Session focused',
  'session-renamed': 'Session renamed',
  'session-removed': 'Session removed',
  'terminal-active': 'Terminal process active',
  'terminal-exited': 'Terminal process exited',
  'terminal-closed': 'Terminal closed',
  'provider-running': 'Agent is working',
  'provider-attention': 'Agent needs attention',
  'provider-completed': 'Agent completed',
  'provider-failed': 'Agent failed',
  'turn-finished': 'Agent turn finished',
  'delegated-started': 'Delegated agent started',
  'delegated-finished': 'Delegated agent finished',
  'command-started': 'Agent command started',
  'command-finished': 'Agent command finished',
  'identity-observed': 'Provider session identity observed',
  'identity-conflict': 'Provider session identity conflict'
};

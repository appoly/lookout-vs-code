import {
  buildDirectContinuation,
  launchCommand,
  type ProviderAdapter,
  type ProviderCapabilities
} from './providerAdapter';

const capabilities: ProviderCapabilities = {
  launch: { support: 'supported', detail: 'Launches the native Claude Code CLI.' },
  lifecycle: {
    support: 'supported',
    detail: 'Uses session-only Claude Code hooks.'
  },
  identity: {
    support: 'supported',
    detail: 'Reads the documented session_id field from authenticated hook input.'
  },
  resume: {
    support: 'supported',
    detail: 'Uses claude --resume with a session ID.'
  },
  fork: {
    support: 'supported',
    detail: 'Uses claude --resume with --fork-session.'
  },
  providerArchive: {
    support: 'unavailable',
    detail: 'Claude Code does not expose a matching provider archive command.'
  },
  usage: {
    support: 'supported',
    detail:
      'The status-line bridge reports account limits, live context, cost, and delegated-agent token counts.'
  },
  historyDiscovery: {
    support: 'limited',
    detail: 'Lookout records observed IDs but does not read Claude transcripts.'
  }
};

export const claudeProvider: ProviderAdapter = {
  kind: 'claude',
  displayName: 'Claude Code',
  executableName: 'claude',
  capabilities,
  buildLaunch: launchCommand,
  buildResume: (request) =>
    buildDirectContinuation('claude', request, (id) => `--resume ${id}`),
  buildFork: (request) =>
    buildDirectContinuation(
      'claude',
      request,
      (id) => `--resume ${id} --fork-session`
    )
};

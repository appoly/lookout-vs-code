import {
  buildDirectContinuation,
  launchCommand,
  type ProviderAdapter,
  type ProviderCapabilities
} from './providerAdapter';

const capabilities: ProviderCapabilities = {
  launch: { support: 'supported', detail: 'Launches the native Codex CLI.' },
  lifecycle: {
    support: 'supported',
    detail: 'Uses session-only Codex lifecycle hooks after provider trust review.'
  },
  identity: {
    support: 'supported',
    detail: 'Reads the documented session_id field from authenticated hook input.'
  },
  resume: { support: 'supported', detail: 'Uses codex resume by session ID.' },
  fork: { support: 'supported', detail: 'Uses codex fork by session ID.' },
  providerArchive: {
    support: 'supported',
    detail: 'Codex supports archive and unarchive by session ID.'
  },
  usage: {
    support: 'supported',
    detail:
      'Structured account usage is available, and direct launches can receive a native rollout token budget.'
  },
  historyDiscovery: {
    support: 'limited',
    detail: 'Lookout records observed IDs but does not read Codex transcripts.'
  }
};

export const codexProvider: ProviderAdapter = {
  kind: 'codex',
  displayName: 'Codex',
  executableName: 'codex',
  capabilities,
  buildLaunch: launchCommand,
  buildResume: (request) =>
    buildDirectContinuation('codex', request, (id) => `resume ${id}`),
  buildFork: (request) =>
    buildDirectContinuation('codex', request, (id) => `fork ${id}`)
};

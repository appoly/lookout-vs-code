import type { AgentKind } from '../types';
import { directCommandExecutable } from '../directCommand';
import { listProviders } from '../providers/providerRegistry';
import type {
  ProviderAdapter,
  ProviderCapabilities
} from '../providers/providerAdapter';

export const BUILTIN_PROFILE_IDS = {
  codex: 'builtin.codex',
  claude: 'builtin.claude',
  custom: 'builtin.generic'
} as const satisfies Readonly<Record<AgentKind, string>>;

export type DetectableProviderKind = 'codex' | 'claude';

export interface ProfileCommandConfiguration {
  readonly codex?: string;
  readonly claude?: string;
}

export interface ExecutableResolution {
  readonly available: boolean;
  readonly resolvedPath?: string;
  readonly detail?: string;
}

/**
 * Resolve one executable token in the extension host where the terminal will
 * run. Implementations may use PATH or other bounded, provider-specific lookup.
 */
export type ExecutableResolver = (
  executable: string
) => Promise<ExecutableResolution>;

export type ProfileAvailability =
  | {
      readonly state: 'available';
      readonly executable: string;
      readonly resolvedPath?: string;
      readonly detail?: string;
    }
  | {
      readonly state: 'missing';
      readonly executable: string;
      readonly detail: string;
    }
  | {
      readonly state: 'unconfigured' | 'not-direct' | 'resolver-error';
      readonly detail: string;
    }
  | {
      readonly state: 'configuration-required';
      readonly detail: string;
    };

export interface AgentProfile {
  readonly id: string;
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly description: string;
  /** A setting identifier, never the potentially secret-bearing command. */
  readonly commandReference?:
    | 'lookout.codex.command'
    | 'lookout.claude.command';
  readonly availability: ProfileAvailability;
  readonly capabilities: ProviderCapabilities;
}

export interface ProfileCatalogOptions {
  readonly commands: ProfileCommandConfiguration;
  readonly resolveExecutable: ExecutableResolver;
  /** Injectable for pure tests; production defaults to the provider registry. */
  readonly providers?: readonly ProviderAdapter[];
}

export async function buildProfileCatalog(
  options: ProfileCatalogOptions
): Promise<readonly AgentProfile[]> {
  const providers = options.providers ?? listProviders();
  return Promise.all(
    providers.map((provider) => profileFor(provider, options))
  );
}

export function profileById(
  profiles: readonly AgentProfile[],
  profileId: string
): AgentProfile | undefined {
  return profiles.find((profile) => profile.id === profileId);
}

/**
 * Extract a direct provider executable without evaluating a shell expression.
 * The returned value is safe to pass to an injected executable resolver.
 */
export function directProviderExecutable(
  configuredCommand: string,
  kind: DetectableProviderKind
): string | undefined {
  const first = directCommandExecutable(configuredCommand);
  if (!first) {
    return undefined;
  }
  const base = first
    .replace(/\\/g, '/')
    .split('/')
    .at(-1)
    ?.toLowerCase();
  return base === kind || base === `${kind}.exe` ? first : undefined;
}

async function profileFor(
  provider: ProviderAdapter,
  options: ProfileCatalogOptions
): Promise<AgentProfile> {
  if (provider.kind === 'custom') {
    return {
      id: BUILTIN_PROFILE_IDS.custom,
      kind: 'custom',
      displayName: 'Generic terminal agent',
      description:
        'Launch a command chosen at runtime and use Lookout’s explicit attention helper.',
      availability: {
        state: 'configuration-required',
        detail: 'Choose a command when launching this profile.'
      },
      capabilities: provider.capabilities
    };
  }

  const kind = provider.kind;
  const configuredCommand = options.commands[kind]?.trim() ?? '';
  const commandReference = kind === 'codex'
    ? 'lookout.codex.command'
    : 'lookout.claude.command';
  const availability = await detectProvider(
    configuredCommand,
    kind,
    options.resolveExecutable
  );
  return {
    id: BUILTIN_PROFILE_IDS[kind],
    kind,
    displayName: provider.displayName,
    description: `${provider.displayName} through its native terminal CLI.`,
    commandReference,
    availability,
    capabilities: effectiveCapabilities(provider, availability)
  };
}

async function detectProvider(
  configuredCommand: string,
  kind: DetectableProviderKind,
  resolveExecutable: ExecutableResolver
): Promise<ProfileAvailability> {
  if (!configuredCommand) {
    return {
      state: 'unconfigured',
      detail: `Configure a direct ${kind} command before launching.`
    };
  }
  const executable = directProviderExecutable(configuredCommand, kind);
  if (!executable) {
    return {
      state: 'not-direct',
      detail:
        'The configured command is a wrapper or shell expression. It can be launched, but deep lifecycle and continuation capabilities cannot be promised.'
    };
  }
  try {
    const resolution = await resolveExecutable(executable);
    return resolution.available
      ? {
          state: 'available',
          executable,
          ...(resolution.resolvedPath
            ? { resolvedPath: resolution.resolvedPath }
            : {}),
          ...(resolution.detail ? { detail: resolution.detail } : {})
        }
      : {
          state: 'missing',
          executable,
          detail:
            resolution.detail ??
            `${executable} was not found in the current extension host.`
        };
  } catch (error) {
    return {
      state: 'resolver-error',
      detail: `Executable detection failed: ${errorMessage(error)}`
    };
  }
}

function effectiveCapabilities(
  provider: ProviderAdapter,
  availability: ProfileAvailability
): ProviderCapabilities {
  if (availability.state === 'available') {
    return provider.capabilities;
  }
  if (availability.state === 'not-direct') {
    return {
      ...provider.capabilities,
      lifecycle: {
        support: 'limited',
        detail: 'Deep lifecycle integration requires a direct provider command.'
      },
      identity: {
        support: 'unavailable',
        detail: 'Provider identity capture requires direct lifecycle hooks.'
      },
      resume: {
        support: 'unavailable',
        detail: 'Safe resume requires a direct provider command.'
      },
      fork: {
        support: 'unavailable',
        detail: 'Safe fork requires a direct provider command.'
      }
    };
  }
  return {
    ...provider.capabilities,
    launch: {
      support: 'unavailable',
      detail: availability.detail
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Keep the registry dependency observable for integration without exposing its
// mutable implementation through the profile DTO.
export function builtinProfileForKind(kind: AgentKind): AgentProfile['id'] {
  return BUILTIN_PROFILE_IDS[kind];
}

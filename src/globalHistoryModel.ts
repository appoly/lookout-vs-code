import { createHash, randomUUID } from 'node:crypto';
import type { AgentSession, ManagedAgentKind, SessionStatus } from './types';

export const GLOBAL_HISTORY_VERSION = 1 as const;
export const GLOBAL_HISTORY_MAX_RECORDS = 500;
export const GLOBAL_HISTORY_MAX_TOMBSTONES = 1_000;
export const GLOBAL_HISTORY_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
export const GLOBAL_HISTORY_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const GLOBAL_HISTORY_INTENT_TTL_MS = 5 * 60 * 1_000;

export type ExecutionHostKind =
  | 'local'
  | 'wsl'
  | 'ssh'
  | 'dev-container'
  | 'other';

export interface WorkspaceIdentity {
  readonly key: string;
  readonly uri: string;
  readonly label: string;
  readonly hostKind: ExecutionHostKind;
  readonly hostScope: string;
}

export interface GlobalProviderReference {
  readonly provider: ManagedAgentKind;
  readonly id: string;
  readonly state: 'available' | 'provider-archived' | 'unavailable' | 'unknown';
}

export interface GlobalHistoryRecord {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly workspace: WorkspaceIdentity;
  readonly kind: AgentSession['kind'];
  readonly label: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: SessionStatus;
  readonly unread: boolean;
  readonly eventCount: number;
  readonly attentionEventCount: number;
  readonly provider?: GlobalProviderReference;
  readonly lineageOperation: AgentSession['lineage']['operation'];
  readonly archivedAt?: number;
  readonly exitCode?: number;
}

export interface GlobalHistoryTombstone {
  readonly id: string;
  readonly workspaceKey: string;
  readonly deletedAt: number;
}

export interface GlobalHistoryIntent {
  readonly id: string;
  readonly recordId: string;
  readonly workspaceKey: string;
  readonly operation: 'resume' | 'fork';
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface GlobalHistoryEnvelope {
  readonly version: typeof GLOBAL_HISTORY_VERSION;
  readonly revision: number;
  readonly records: readonly GlobalHistoryRecord[];
  readonly tombstones: readonly GlobalHistoryTombstone[];
  readonly intents: readonly GlobalHistoryIntent[];
}

export interface GlobalHistoryEventCounts {
  readonly events: number;
  readonly attention: number;
}

export function emptyGlobalHistory(): GlobalHistoryEnvelope {
  return {
    version: GLOBAL_HISTORY_VERSION,
    revision: 0,
    records: [],
    tombstones: [],
    intents: []
  };
}

export function globalHistoryRecord(
  session: AgentSession,
  workspace: WorkspaceIdentity,
  counts: GlobalHistoryEventCounts
): GlobalHistoryRecord {
  const reference = session.providerSessions.at(-1);
  return {
    id: globalHistoryRecordId(workspace.key, session.id),
    sourceSessionId: boundedToken(session.id, 160),
    workspace: sanitizeWorkspace(workspace),
    kind: session.kind,
    label: boundedText(session.label, 120, 'Agent session'),
    cwd: boundedPath(session.cwd),
    createdAt: safeTime(session.createdAt),
    updatedAt: safeTime(session.updatedAt),
    status: session.status,
    unread: session.unread,
    eventCount: boundedCount(counts.events),
    attentionEventCount: boundedCount(counts.attention),
    ...(reference
      ? {
          provider: {
            provider: reference.provider,
            id: boundedToken(reference.id, 512),
            state: reference.state
          }
        }
      : {}),
    lineageOperation: session.lineage.operation,
    ...(session.archivedAt === undefined
      ? {}
      : { archivedAt: safeTime(session.archivedAt) }),
    ...(session.exitCode === undefined
      ? {}
      : { exitCode: Math.trunc(session.exitCode) })
  };
}

export function globalHistoryRecordId(
  workspaceKey: string,
  sessionId: string
): string {
  return createHash('sha256')
    .update(workspaceKey)
    .update('\0')
    .update(sessionId)
    .digest('hex');
}

export function replaceWorkspaceHistory(
  envelope: GlobalHistoryEnvelope,
  workspaceKey: string,
  records: readonly GlobalHistoryRecord[],
  now = Date.now()
): GlobalHistoryEnvelope {
  const current = normalizeGlobalHistory(envelope, now);
  const incoming = new Map(
    records
      .filter((record) => record.workspace.key === workspaceKey)
      .map((record) => [record.id, record])
  );
  const tombstones = new Map(
    current.tombstones.map((tombstone) => [tombstone.id, tombstone])
  );
  for (const [id, record] of [...incoming]) {
    const tombstone = tombstones.get(id);
    if (tombstone && tombstone.deletedAt >= record.updatedAt) {
      incoming.delete(id);
    }
  }
  for (const record of current.records) {
    if (record.workspace.key === workspaceKey && !incoming.has(record.id)) {
      tombstones.set(record.id, {
        id: record.id,
        workspaceKey,
        deletedAt: now
      });
    }
  }
  for (const id of incoming.keys()) {
    tombstones.delete(id);
  }
  const retainedOtherRecords = current.records.filter(
    (record) => record.workspace.key !== workspaceKey
  );
  return normalizeGlobalHistory(
    {
      version: GLOBAL_HISTORY_VERSION,
      revision: current.revision + 1,
      records: [...retainedOtherRecords, ...incoming.values()],
      tombstones: [...tombstones.values()],
      intents: current.intents
    },
    now
  );
}

export function deleteGlobalHistoryRecords(
  envelope: GlobalHistoryEnvelope,
  ids: readonly string[],
  now = Date.now()
): GlobalHistoryEnvelope {
  const deleting = new Set(ids);
  if (deleting.size === 0) {
    return envelope;
  }
  const tombstones = new Map(
    envelope.tombstones.map((tombstone) => [tombstone.id, tombstone])
  );
  for (const record of envelope.records) {
    if (deleting.has(record.id)) {
      tombstones.set(record.id, {
        id: record.id,
        workspaceKey: record.workspace.key,
        deletedAt: now
      });
    }
  }
  return normalizeGlobalHistory(
    {
      ...envelope,
      revision: envelope.revision + 1,
      records: envelope.records.filter((record) => !deleting.has(record.id)),
      tombstones: [...tombstones.values()]
    },
    now
  );
}

export function createGlobalHistoryIntent(
  envelope: GlobalHistoryEnvelope,
  recordId: string,
  operation: GlobalHistoryIntent['operation'],
  now = Date.now()
): { readonly envelope: GlobalHistoryEnvelope; readonly intent?: GlobalHistoryIntent } {
  const record = envelope.records.find((candidate) => candidate.id === recordId);
  if (!record?.provider || record.provider.state !== 'available') {
    return { envelope };
  }
  const intent: GlobalHistoryIntent = {
    id: randomUUID(),
    recordId,
    workspaceKey: record.workspace.key,
    operation,
    createdAt: now,
    expiresAt: now + GLOBAL_HISTORY_INTENT_TTL_MS
  };
  return {
    intent,
    envelope: normalizeGlobalHistory(
      {
        ...envelope,
        revision: envelope.revision + 1,
        intents: [
          ...envelope.intents.filter(
            (candidate) => candidate.recordId !== recordId
          ),
          intent
        ]
      },
      now
    )
  };
}

export function claimGlobalHistoryIntent(
  envelope: GlobalHistoryEnvelope,
  workspaceKey: string,
  now = Date.now()
): {
  readonly envelope: GlobalHistoryEnvelope;
  readonly intent?: GlobalHistoryIntent;
  readonly record?: GlobalHistoryRecord;
} {
  const current = normalizeGlobalHistory(envelope, now);
  const intent = current.intents
    .filter((candidate) => candidate.workspaceKey === workspaceKey)
    .sort((left, right) => left.createdAt - right.createdAt)[0];
  if (!intent) {
    return { envelope: current };
  }
  const record = current.records.find(
    (candidate) => candidate.id === intent.recordId
  );
  return {
    envelope: {
      ...current,
      revision: current.revision + 1,
      intents: current.intents.filter((candidate) => candidate.id !== intent.id)
    },
    intent,
    ...(record ? { record } : {})
  };
}

export function normalizeGlobalHistory(
  value: unknown,
  now = Date.now()
): GlobalHistoryEnvelope {
  const candidate = isObject(value) ? value : {};
  if (
    typeof candidate.version === 'number' &&
    candidate.version !== GLOBAL_HISTORY_VERSION
  ) {
    return emptyGlobalHistory();
  }
  const revision = safeNonNegativeInteger(candidate.revision);
  const records = Array.isArray(candidate.records)
    ? candidate.records.flatMap((record) => decodeRecord(record))
    : [];
  const tombstones = Array.isArray(candidate.tombstones)
    ? candidate.tombstones.flatMap((tombstone) => decodeTombstone(tombstone))
    : [];
  const intents = Array.isArray(candidate.intents)
    ? candidate.intents.flatMap((intent) => decodeIntent(intent, now))
    : [];
  const latestTombstones = new Map<string, GlobalHistoryTombstone>();
  for (const tombstone of tombstones) {
    if (now - tombstone.deletedAt <= GLOBAL_HISTORY_TOMBSTONE_RETENTION_MS) {
      const existing = latestTombstones.get(tombstone.id);
      if (!existing || existing.deletedAt < tombstone.deletedAt) {
        latestTombstones.set(tombstone.id, tombstone);
      }
    }
  }
  const tombstoned = new Set(latestTombstones.keys());
  const latestRecords = new Map<string, GlobalHistoryRecord>();
  for (const record of records) {
    if (
      !tombstoned.has(record.id) &&
      (record.status !== 'closed' || now - record.updatedAt <= GLOBAL_HISTORY_RETENTION_MS)
    ) {
      const existing = latestRecords.get(record.id);
      if (!existing || existing.updatedAt <= record.updatedAt) {
        latestRecords.set(record.id, record);
      }
    }
  }
  return {
    version: GLOBAL_HISTORY_VERSION,
    revision,
    records: [...latestRecords.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, GLOBAL_HISTORY_MAX_RECORDS),
    tombstones: [...latestTombstones.values()]
      .sort((left, right) => right.deletedAt - left.deletedAt)
      .slice(0, GLOBAL_HISTORY_MAX_TOMBSTONES),
    intents: intents
      .filter((intent) => intent.expiresAt > now)
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, 20)
  };
}

function decodeRecord(value: unknown): GlobalHistoryRecord[] {
  if (!isObject(value) || !isObject(value.workspace)) {
    return [];
  }
  const kind = value.kind;
  const status = value.status;
  const operation = value.lineageOperation;
  if (
    typeof value.id !== 'string' ||
    typeof value.sourceSessionId !== 'string' ||
    (kind !== 'codex' && kind !== 'claude' && kind !== 'custom') ||
    !isSessionStatus(status) ||
    !isLineageOperation(operation)
  ) {
    return [];
  }
  const workspace = decodeWorkspace(value.workspace);
  if (!workspace) {
    return [];
  }
  const provider = decodeProvider(value.provider);
  return [{
    id: boundedToken(value.id, 160),
    sourceSessionId: boundedToken(value.sourceSessionId, 160),
    workspace,
    kind,
    label: boundedText(value.label, 120, 'Agent session'),
    cwd: boundedPath(value.cwd),
    createdAt: safeTime(value.createdAt),
    updatedAt: safeTime(value.updatedAt),
    status,
    unread: value.unread === true,
    eventCount: boundedCount(value.eventCount),
    attentionEventCount: boundedCount(value.attentionEventCount),
    ...(provider ? { provider } : {}),
    lineageOperation: operation,
    ...(typeof value.archivedAt === 'number'
      ? { archivedAt: safeTime(value.archivedAt) }
      : {}),
    ...(typeof value.exitCode === 'number'
      ? { exitCode: Math.trunc(value.exitCode) }
      : {})
  }];
}

function decodeWorkspace(value: Record<string, unknown>): WorkspaceIdentity | undefined {
  if (
    typeof value.key !== 'string' ||
    typeof value.uri !== 'string' ||
    typeof value.hostScope !== 'string' ||
    !isHostKind(value.hostKind)
  ) {
    return undefined;
  }
  const uri = safeWorkspaceUri(value.uri);
  if (!uri) {
    return undefined;
  }
  return sanitizeWorkspace({
    key: value.key,
    uri,
    label: typeof value.label === 'string' ? value.label : 'Workspace',
    hostKind: value.hostKind,
    hostScope: value.hostScope
  });
}

function safeWorkspaceUri(value: string): string | undefined {
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:' && uri.protocol !== 'vscode-remote:') {
      return undefined;
    }
    if (uri.username || uri.password) {
      return undefined;
    }
    uri.search = '';
    uri.hash = '';
    return uri.toString();
  } catch {
    return undefined;
  }
}

function decodeProvider(value: unknown): GlobalProviderReference | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (
    (value.provider !== 'codex' && value.provider !== 'claude') ||
    typeof value.id !== 'string' ||
    !isProviderState(value.state)
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    id: boundedToken(value.id, 512),
    state: value.state
  };
}

function decodeTombstone(value: unknown): GlobalHistoryTombstone[] {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.workspaceKey !== 'string' ||
    typeof value.deletedAt !== 'number'
  ) {
    return [];
  }
  return [{
    id: boundedToken(value.id, 160),
    workspaceKey: boundedToken(value.workspaceKey, 160),
    deletedAt: safeTime(value.deletedAt)
  }];
}

function decodeIntent(value: unknown, now: number): GlobalHistoryIntent[] {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.recordId !== 'string' ||
    typeof value.workspaceKey !== 'string' ||
    (value.operation !== 'resume' && value.operation !== 'fork') ||
    typeof value.createdAt !== 'number' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt <= now
  ) {
    return [];
  }
  return [{
    id: boundedToken(value.id, 160),
    recordId: boundedToken(value.recordId, 160),
    workspaceKey: boundedToken(value.workspaceKey, 160),
    operation: value.operation,
    createdAt: safeTime(value.createdAt),
    expiresAt: safeTime(value.expiresAt)
  }];
}

function sanitizeWorkspace(value: WorkspaceIdentity): WorkspaceIdentity {
  return {
    key: boundedToken(value.key, 160),
    uri: boundedText(value.uri, 8_192, ''),
    label: boundedText(value.label, 160, 'Workspace'),
    hostKind: value.hostKind,
    hostScope: boundedToken(value.hostScope, 160)
  };
}

function boundedText(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = stripControls(value, false).trim();
  return cleaned ? cleaned.slice(0, maximum) : fallback;
}

function boundedPath(value: unknown): string {
  return boundedText(value, 4_096, '');
}

function boundedToken(value: string, maximum: number): string {
  return stripControls(value, true).slice(0, maximum);
}

function stripControls(value: string, removeWhitespace: boolean): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || code === 127 || (removeWhitespace && /\s/.test(character))) {
        return removeWhitespace ? '' : ' ';
      }
      return character;
    })
    .join('');
}

function boundedCount(value: unknown): number {
  return Math.min(1_000_000, safeNonNegativeInteger(value));
}

function safeTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHostKind(value: unknown): value is ExecutionHostKind {
  return value === 'local' || value === 'wsl' || value === 'ssh' ||
    value === 'dev-container' || value === 'other';
}

function isProviderState(value: unknown): value is GlobalProviderReference['state'] {
  return value === 'available' || value === 'provider-archived' ||
    value === 'unavailable' || value === 'unknown';
}

function isLineageOperation(value: unknown): value is AgentSession['lineage']['operation'] {
  return value === 'new' || value === 'resume' || value === 'fork' || value === 'reopen';
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === 'starting' || value === 'active' || value === 'running' ||
    value === 'background' || value === 'attention' || value === 'idle' ||
    value === 'completed' || value === 'failed' || value === 'unknown' ||
    value === 'closed';
}

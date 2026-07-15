import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle
} from 'node:fs/promises';
import * as path from 'node:path';
import { CoordinationClient } from './coordinationClient';
import { COORDINATION_PROTOCOL_VERSION } from './coordinationModel';
import {
  CoordinationServer,
  type CoordinationEndpoint
} from './coordinationServer';

const ENDPOINT_FILE = 'coordination-v1.endpoint.json';
const LOCK_FILE = 'coordination-v1.owner.lock';
const OWNER_STALE_MS = 15_000;
const ACQUIRE_TIMEOUT_MS = 4_000;

export type CoordinationConnection =
  | {
      readonly state: 'connected';
      readonly client: CoordinationClient;
      readonly endpoint: CoordinationEndpoint;
      readonly owned: boolean;
    }
  | {
      readonly state: 'incompatible' | 'unavailable';
      readonly detail: string;
    };

export class CoordinationEndpointBroker {
  private readonly endpointPath: string;
  private readonly lockPath: string;
  private server: Pick<CoordinationServer, 'start' | 'stop'> | undefined;
  private lock: FileHandle | undefined;
  private lockHeartbeatTimer: NodeJS.Timeout | undefined;
  private ownedEndpoint: CoordinationEndpoint | undefined;

  public constructor(
    private readonly directory: string,
    private readonly createServer: (
      token: string,
      ownerId: string
    ) => Pick<CoordinationServer, 'start' | 'stop'> = (token, ownerId) =>
      new CoordinationServer(token, ownerId)
  ) {
    this.endpointPath = path.join(directory, ENDPOINT_FILE);
    this.lockPath = path.join(directory, LOCK_FILE);
  }

  public async connectOrOwn(
    token: string,
    ownerId: string
  ): Promise<CoordinationConnection> {
    await mkdir(this.directory, { recursive: true });
    const startedAt = Date.now();
    while (Date.now() - startedAt <= ACQUIRE_TIMEOUT_MS) {
      const descriptor = await this.readEndpoint();
      if (descriptor === 'incompatible') {
        if (await this.lockIsStale()) {
          await unlink(this.endpointPath).catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          continue;
        }
        return {
          state: 'incompatible',
          detail: 'Another Lookout version owns this execution-host coordinator.'
        };
      }
      if (descriptor) {
        const client = new CoordinationClient(descriptor, token);
        if (await client.health()) {
          return {
            state: 'connected',
            client,
            endpoint: descriptor,
            owned: false
          };
        }
      }
      const lock = await this.tryAcquireLock();
      if (lock) {
        try {
          const server = this.createServer(token, ownerId);
          const endpoint = await server.start();
          try {
            await this.writeEndpoint(endpoint);
          } catch (error) {
            // The listener exists before its descriptor can be published. If
            // publication fails, stop it here so an unreachable coordinator
            // cannot survive outside broker ownership.
            await server.stop().catch(() => undefined);
            throw error;
          }
          this.server = server;
          this.lock = lock;
          this.lockHeartbeatTimer = setInterval(() => {
            const now = new Date();
            void utimes(this.lockPath, now, now).catch(() => undefined);
          }, 5_000);
          this.ownedEndpoint = endpoint;
          return {
            state: 'connected',
            client: new CoordinationClient(endpoint, token),
            endpoint,
            owned: true
          };
        } catch (error) {
          await lock.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          throw error;
        }
      }
      await this.removeStaleOwnership(descriptor || undefined);
      await delay(75);
    }
    return {
      state: 'unavailable',
      detail: 'Timed out connecting to the execution-host coordinator.'
    };
  }

  public async dispose(): Promise<void> {
    await this.server?.stop().catch(() => undefined);
    this.server = undefined;
    if (this.ownedEndpoint) {
      const current = await this.readEndpoint();
      if (
        current !== 'incompatible' &&
        current?.ownerId === this.ownedEndpoint.ownerId
      ) {
        await unlink(this.endpointPath).catch(() => undefined);
      }
    }
    this.ownedEndpoint = undefined;
    const ownedLock = this.lock;
    this.lock = undefined;
    if (this.lockHeartbeatTimer) {
      clearInterval(this.lockHeartbeatTimer);
      this.lockHeartbeatTimer = undefined;
    }
    if (ownedLock) {
      await ownedLock.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async readEndpoint(): Promise<CoordinationEndpoint | 'incompatible' | undefined> {
    try {
      const value = JSON.parse(await readFile(this.endpointPath, 'utf8')) as unknown;
      if (!isObject(value) || typeof value.protocolVersion !== 'number') {
        return undefined;
      }
      if (value.protocolVersion !== COORDINATION_PROTOCOL_VERSION) {
        return 'incompatible';
      }
      if (
        typeof value.port !== 'number' ||
        !Number.isInteger(value.port) ||
        value.port < 1 ||
        value.port > 65_535 ||
        typeof value.ownerId !== 'string' ||
        typeof value.startedAt !== 'number'
      ) {
        return undefined;
      }
      return {
        protocolVersion: COORDINATION_PROTOCOL_VERSION,
        port: value.port,
        ownerId: value.ownerId.slice(0, 160),
        startedAt: Math.max(0, Math.trunc(value.startedAt))
      };
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }

  private async writeEndpoint(endpoint: CoordinationEndpoint): Promise<void> {
    const temporary = `${this.endpointPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(endpoint)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    try {
      await rename(temporary, this.endpointPath);
    } catch (error) {
      if (process.platform !== 'win32') {
        throw error;
      }
      await unlink(this.endpointPath).catch(() => undefined);
      await rename(temporary, this.endpointPath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async tryAcquireLock(): Promise<FileHandle | undefined> {
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
        'utf8'
      );
      return lock;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        return undefined;
      }
      throw error;
    }
  }

  private async removeStaleOwnership(
    descriptor: CoordinationEndpoint | undefined
  ): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (Date.now() - details.mtimeMs <= OWNER_STALE_MS) {
        return;
      }
      if (descriptor) {
        // The caller already failed the authenticated health check.
        await unlink(this.endpointPath).catch(() => undefined);
      }
      await unlink(this.lockPath).catch(() => undefined);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const details = await stat(this.lockPath);
      return Date.now() - details.mtimeMs > OWNER_STALE_MS;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return true;
      }
      throw error;
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

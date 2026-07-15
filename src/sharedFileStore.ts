import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises';
import * as path from 'node:path';

export interface SharedFileStoreOptions<T> {
  readonly directory: string;
  readonly filename: string;
  readonly empty: () => T;
  readonly decode: (value: unknown) => T;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly now?: () => number;
}

const DEFAULT_STALE_LOCK_MS = 15_000;
const LOCK_RECOVERY_GRACE_MS = 5_000;

/**
 * Small cross-process JSON store with an atomic lock file and rename. It is
 * intended for extension-global metadata shared by windows on one execution
 * host, never for workspace files or user content.
 */
export class SharedFileStore<T> {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;

  public constructor(private readonly options: SharedFileStoreOptions<T>) {
    this.filePath = path.join(options.directory, options.filename);
    this.lockPath = `${this.filePath}.lock`;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.lockTimeoutMs =
      options.lockTimeoutMs ?? this.staleLockMs + LOCK_RECOVERY_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  public async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
  }

  public async read(): Promise<T> {
    await this.initialize();
    return this.readUnlocked();
  }

  public async update(mutator: (current: T) => T): Promise<T> {
    await this.initialize();
    const lock = await this.acquireLock();
    try {
      const next = this.options.decode(mutator(await this.readUnlocked()));
      await this.writeUnlocked(next);
      return next;
    } finally {
      await lock.close().catch(() => undefined);
      await unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async readUnlocked(): Promise<T> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      return this.options.decode(JSON.parse(text) as unknown);
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) {
        return this.options.empty();
      }
      throw error;
    }
  }

  private async writeUnlocked(value: T): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      // Windows rename does not replace an existing destination atomically.
      if (process.platform !== 'win32') {
        throw error;
      }
      await unlink(this.filePath).catch((unlinkError) => {
        if (!isMissing(unlinkError)) {
          throw unlinkError;
        }
      });
      await rename(temporary, this.filePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async acquireLock(): Promise<FileHandle> {
    const startedAt = this.now();
    while (this.now() - startedAt <= this.lockTimeoutMs) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: this.now() })}\n`,
          'utf8'
        );
        return handle;
      } catch (error) {
        if (!isExists(error)) {
          throw error;
        }
        await this.removeStaleLock();
        await delay(25);
      }
    }
    throw new Error(`Timed out acquiring shared metadata lock: ${this.lockPath}`);
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const details = await stat(this.lockPath);
      if (this.now() - details.mtimeMs > this.staleLockMs) {
        await unlink(this.lockPath).catch(() => undefined);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isExists(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

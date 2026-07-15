import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  COORDINATION_PROTOCOL_VERSION,
  CoordinationRegistry,
  decodeFocusRequest,
  decodeRegistration
} from './coordinationModel';

const MAX_BODY_BYTES = 128 * 1_024;

export interface CoordinationEndpoint {
  readonly protocolVersion: typeof COORDINATION_PROTOCOL_VERSION;
  readonly port: number;
  readonly ownerId: string;
  readonly startedAt: number;
}

export class CoordinationServer {
  private server: Server | undefined;
  private readonly registry: CoordinationRegistry;

  public constructor(
    private readonly token: string,
    private readonly ownerId: string,
    now: () => number = Date.now
  ) {
    this.registry = new CoordinationRegistry(now);
  }

  public async start(): Promise<CoordinationEndpoint> {
    if (this.server) {
      throw new Error('Coordination server is already running');
    }
    const server = createServer((request, response) => {
      void this.handle(request).then(
        (result) => {
          response.writeHead(result.status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
          });
          response.end(`${JSON.stringify(result.body)}\n`);
        },
        () => {
          response.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
          });
          response.end('{"error":"internal"}\n');
        }
      );
    });
    server.maxHeadersCount = 32;
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    // The one-shot listener below rejects startup; this persistent listener
    // also prevents later socket-level errors from becoming uncaught extension
    // host exceptions.
    server.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Coordination server did not receive a TCP address');
    }
    this.server = server;
    return {
      protocolVersion: COORDINATION_PROTOCOL_VERSION,
      port: address.port,
      ownerId: this.ownerId,
      startedAt: Date.now()
    };
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage): Promise<{
    readonly status: number;
    readonly body: unknown;
  }> {
    if (!this.authenticated(request)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (request.method === 'GET' && request.url === '/v1/health') {
      return {
        status: 200,
        body: {
          protocolVersion: COORDINATION_PROTOCOL_VERSION,
          ownerId: this.ownerId
        }
      };
    }
    if (request.method === 'POST' && request.url === '/v1/heartbeat') {
      const registration = decodeRegistration(await readJson(request));
      if (!registration) {
        return { status: 400, body: { error: 'invalid-registration' } };
      }
      return { status: 200, body: this.registry.heartbeat(registration) };
    }
    if (request.method === 'POST' && request.url === '/v1/action/focus') {
      const action = decodeFocusRequest(await readJson(request));
      if (!action) {
        return { status: 400, body: { error: 'invalid-action' } };
      }
      const queued = this.registry.queueFocus(
        action.sourceWindowId,
        action.targetWindowId,
        action.sessionId
      );
      return queued
        ? { status: 202, body: { accepted: true, actionId: queued.id } }
        : { status: 404, body: { error: 'target-unavailable' } };
    }
    return { status: 404, body: { error: 'not-found' } };
  }

  private authenticated(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const expectedBytes = Buffer.from(this.token);
    const suppliedBytes = Buffer.from(supplied);
    return expectedBytes.length === suppliedBytes.length &&
      timingSafeEqual(expectedBytes, suppliedBytes);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      request.destroy();
      throw new Error('Coordination request is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

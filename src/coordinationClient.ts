import { request } from 'node:http';
import {
  COORDINATION_PROTOCOL_VERSION,
  type CoordinatedWindowRegistration,
  type CoordinationHeartbeatResult
} from './coordinationModel';
import type { CoordinationEndpoint } from './coordinationServer';

const MAX_RESPONSE_BYTES = 256 * 1_024;
const REQUEST_TIMEOUT_MS = 2_500;

export class CoordinationClient {
  public constructor(
    private readonly endpoint: CoordinationEndpoint,
    private readonly token: string
  ) {}

  public async health(): Promise<boolean> {
    try {
      const result = await this.send('GET', '/v1/health');
      return result.status === 200 &&
        isObject(result.body) &&
        result.body.protocolVersion === COORDINATION_PROTOCOL_VERSION &&
        result.body.ownerId === this.endpoint.ownerId;
    } catch {
      return false;
    }
  }

  public async heartbeat(
    registration: CoordinatedWindowRegistration
  ): Promise<CoordinationHeartbeatResult> {
    const result = await this.send('POST', '/v1/heartbeat', registration);
    if (
      result.status !== 200 ||
      !isObject(result.body) ||
      result.body.protocolVersion !== COORDINATION_PROTOCOL_VERSION ||
      !Array.isArray(result.body.windows) ||
      !Array.isArray(result.body.actions)
    ) {
      throw new Error('Invalid coordination heartbeat response');
    }
    return result.body as unknown as CoordinationHeartbeatResult;
  }

  public async focus(
    sourceWindowId: string,
    targetWindowId: string,
    sessionId: string
  ): Promise<boolean> {
    const result = await this.send('POST', '/v1/action/focus', {
      sourceWindowId,
      targetWindowId,
      sessionId
    });
    return result.status === 202;
  }

  private send(
    method: 'GET' | 'POST',
    pathname: string,
    body?: unknown
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const outgoing = request({
        hostname: '127.0.0.1',
        port: this.endpoint.port,
        path: pathname,
        method,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(payload.length)
              }
            : {})
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Coordination response is too large'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode ?? 0,
              body: text ? JSON.parse(text) as unknown : undefined
            });
          } catch (error) {
            reject(error);
          }
        });
        response.on('error', reject);
      });
      outgoing.on('timeout', () => outgoing.destroy(new Error('Coordination request timed out')));
      outgoing.on('error', reject);
      if (payload) {
        outgoing.write(payload);
      }
      outgoing.end();
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

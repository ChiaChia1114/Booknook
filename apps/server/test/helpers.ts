import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { loadConfig, type Config } from '../src/config';
import { buildApp, type BuildOptions } from '../src/app';
import type { AppContext } from '../src/context';
import type { FastifyInstance } from 'fastify';

process.removeAllListeners('warning');

export interface TestServer {
  app: FastifyInstance;
  ctx: AppContext;
  baseUrl: string;
  wsBase: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startServer(opts: BuildOptions & { config?: Partial<Config> } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'athena-test-'));
  const config = loadConfig(
    { ATHENA_TERRAIN_URL: 'off', ATHENA_WEATHER_URL: 'off' },
    { dataDir, port: 0, host: '127.0.0.1', authRateLimitPerMin: 10_000, logLevel: 'warn', webDist: null, linkLossGraceS: 2, ...opts.config },
  );
  const { app, ctx } = await buildApp(config, { logger: false, allowPrivateTargets: true, ...opts });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  config.publicUrl = `http://127.0.0.1:${port}`;
  return {
    app,
    ctx,
    baseUrl: config.publicUrl,
    wsBase: `ws://127.0.0.1:${port}`,
    dataDir,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface Session {
  cookie: string;
  csrf: string;
  userId: string;
  orgId: string;
  email: string;
}

let counter = 0;

/** Signs up a new user (with a personal organisation) and returns the session. */
export async function signup(app: FastifyInstance, extra: Record<string, unknown> = {}): Promise<Session> {
  counter++;
  const email = (extra.email as string) ?? `user${counter}-${Date.now()}@example.com`;
  const res = await app.inject({ method: 'POST', url: '/api/v2/auth/signup', payload: { email, password: 'correct-horse-battery', name: `User ${counter}`, ...extra } });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json();
  return { cookie: cookieHeader(res.headers['set-cookie']), csrf: body.csrfToken, userId: body.user.id, orgId: body.memberships[0]?.orgId, email };
}

export function cookieHeader(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/** Authenticated request helper (cookie session + CSRF). */
export function api(app: FastifyInstance, s: Session) {
  return async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return res;
  };
}

/** Builds a multipart/form-data body. */
export function multipart(fields: Record<string, string>, files: { field: string; filename: string; content: Buffer; type?: string }[]) {
  const boundary = `----athena${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`));
    parts.push(f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 20_000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v: T | undefined | null | false;
      try {
        v = fn();
      } catch (err) {
        return reject(err);
      }
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** A Live WebSocket viewer that records every message. */
export class Viewer {
  readonly messages: any[] = [];
  readonly frames: Buffer[] = [];
  readonly ws: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.frames.push(data as Buffer);
      else this.messages.push(JSON.parse(data.toString()));
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  find(pred: (m: any) => boolean): any {
    return this.messages.find(pred);
  }

  wait(pred: (m: any) => boolean, timeoutMs = 20_000): Promise<any> {
    return waitFor(() => this.messages.find(pred), timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

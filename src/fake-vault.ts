import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeVault {
  /** Base URL, e.g. http://127.0.0.1:41234. Secrets are POSTed to `${url}/secrets`. */
  url: string;
  authToken: string;
  /** Names and lengths of what was stored; values are never exposed. */
  stored(): Array<{ name: string; length: number }>;
  close(): Promise<void>;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_VALUE_CHARS = 4096;
const MAX_BODY_BYTES = 8192;

/**
 * A stand-in for a real secrets service, for demos and tests only: bearer-authenticated, in-memory,
 * and it never returns a stored value, only whether it exists and how long it is.
 */
export async function startFakeVault(opts: { authToken?: string; log?: boolean; port?: number } = {}): Promise<FakeVault> {
  const authToken = opts.authToken ?? randomBytes(24).toString('base64url');
  const secrets = new Map<string, string>();

  const authorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(authToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };
  const send = (res: ServerResponse, status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    const lookup = /^\/secrets\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && lookup !== null) {
      const value = secrets.get(lookup[1] as string);
      return value === undefined ? send(res, 404, { exists: false }) : send(res, 200, { exists: true, length: value.length });
    }
    if (req.method !== 'POST' || req.url !== '/secrets') return send(res, 404, { error: 'not found' });
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return send(res, 400, { error: 'bad request' });
      let parsed: { name?: unknown; value?: unknown };
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'bad request' });
      }
      const { name, value } = parsed;
      if (typeof name !== 'string' || !NAME.test(name) || typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_CHARS) {
        return send(res, 400, { error: 'bad request' });
      }
      secrets.set(name, value);
      if (opts.log) console.error(`[fake-vault] stored "${name}" (${value.length} chars)`);
      send(res, 201, {});
    });
  });
  server.unref();
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    authToken,
    stored: () => [...secrets].map(([name, value]) => ({ name, length: value.length })),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

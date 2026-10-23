import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const MAX_BODY_BYTES = 8192;
const MAX_TOKEN_CHARS = 4096;
const DEFAULT_FLOW_TTL_MS = 5 * 60_000;
const PATH = /^\/connect\/([A-Za-z0-9_-]{43})$/;

interface Flow {
  flowId: string;
  nonce: string;
  expiresAt: number;
  stored: boolean;
  /** True while the sink is being called, so a second submit cannot race the first. */
  sending: boolean;
  waiters: Set<() => void>;
}

/** Receives the secret the moment the page is submitted, e.g. to forward it to a secure service. Must not log it. */
export type SecretSink = (secret: string) => Promise<void>;

export type WaitResult = 'stored' | 'timeout' | 'unknown';

/**
 * Collects one secret through a one-time page on 127.0.0.1, so it never passes through the MCP client or the model.
 * The page hands the secret to the injected sink and keeps no copy; nothing here returns, logs or persists it.
 */
export class TokenCollector {
  private readonly flowTtlMs: number;
  private readonly byNonce = new Map<string, Flow>();
  private readonly byId = new Map<string, Flow>();
  private server: Server | undefined;
  private listening: Promise<number> | undefined;
  private readonly sink: SecretSink;
  private delivered = false;

  constructor(opts: { sink: SecretSink; flowTtlMs?: number }) {
    this.sink = opts.sink;
    this.flowTtlMs = opts.flowTtlMs ?? DEFAULT_FLOW_TTL_MS;
  }

  /** Opens a one-time link. `flowId` is safe to put in `requestState`; the nonce lives only in `url`. */
  async start(): Promise<{ flowId: string; url: string }> {
    const port = await this.listen();
    const flow: Flow = {
      flowId: randomBytes(12).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + this.flowTtlMs,
      stored: false,
      sending: false,
      waiters: new Set(),
    };
    this.byNonce.set(flow.nonce, flow);
    this.byId.set(flow.flowId, flow);
    return { flowId: flow.flowId, url: `http://127.0.0.1:${port}/connect/${flow.nonce}` };
  }

  /** Waits for the page to be submitted. `unknown` means the flow was cancelled, expired or never existed. */
  async wait(flowId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<WaitResult> {
    const flow = this.live(flowId);
    if (flow === undefined) return 'unknown';
    if (!flow.stored) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          flow.waiters.delete(done);
          opts.signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, opts.timeoutMs);
        flow.waiters.add(done);
        if (opts.signal?.aborted) done();
        else opts.signal?.addEventListener('abort', done, { once: true });
      });
    }
    if (!flow.stored) return 'timeout';
    this.forget(flow);
    return 'stored';
  }

  cancel(flowId: string): void {
    const flow = this.byId.get(flowId);
    if (flow !== undefined) this.forget(flow);
  }

  /** Links that are open and not yet submitted, cancelled or expired. */
  activeFlowCount(): number {
    return [...this.byId.values()].filter((f) => !f.stored && Date.now() <= f.expiresAt).length;
  }

  /** True once a secret has been handed to the sink. The secret itself is not kept. */
  isConfigured(): boolean {
    return this.delivered;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    this.byNonce.clear();
    this.byId.clear();
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private live(flowId: string): Flow | undefined {
    const flow = this.byId.get(flowId);
    if (flow === undefined) return undefined;
    if (!flow.stored && Date.now() > flow.expiresAt) {
      this.forget(flow);
      return undefined;
    }
    return flow;
  }

  private forget(flow: Flow): void {
    this.byNonce.delete(flow.nonce);
    this.byId.delete(flow.flowId);
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.unref(); // the page must never keep the stdio server alive
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      this.server = server;
    });
    return this.listening;
  }

  private async deliver(flow: Flow, token: string, res: ServerResponse): Promise<void> {
    if (flow.sending) return reply(res, 409, 'Already submitting');
    flow.sending = true;
    try {
      await this.sink(token);
    } catch {
      flow.sending = false;
      console.error('[token-page] the secret sink failed; the link can be used again');
      return reply(res, 502, FAILED_PAGE);
    }
    flow.sending = false;
    flow.stored = true;
    this.delivered = true;
    this.byNonce.delete(flow.nonce); // single use
    for (const wake of [...flow.waiters]) wake();
    reply(res, 200, DONE_PAGE);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403, 'Forbidden');
    const match = PATH.exec(req.url ?? '');
    if (match === null) return reply(res, 404, 'Not found');
    if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, 'Method not allowed');
    const flow = this.byNonce.get(match[1] as string);
    if (flow === undefined) return reply(res, 404, 'Not found');
    if (Date.now() > flow.expiresAt) {
      this.forget(flow);
      return reply(res, 410, 'This link has expired. Ask for a new one.');
    }
    if (req.method === 'GET') return reply(res, 200, FORM_PAGE);

    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return reply(res, 403, 'Forbidden');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return reply(res, 403, 'Forbidden');
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return reply(res, 415, 'Unsupported content type');
    }
    readBody(req, MAX_BODY_BYTES, (body) => {
      if (body === undefined) return reply(res, 413, 'Too large', true);
      const token = new URLSearchParams(body).get('token') ?? '';
      if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return reply(res, 400, 'Invalid token');
      void this.deliver(flow, token, res);
    });
  }
}

const FAILED_PAGE = '<!doctype html><meta charset="utf-8"><title>Not saved</title><p>The token could not be saved. Go back and try again, or ask for a new link.</p>';
const FORM_PAGE = `<!doctype html><meta charset="utf-8"><title>Release manager: registry token</title>
<style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.5rem;width:100%;margin:.5rem 0}</style>
<h1>Registry token</h1>
<p>Paste the token for the release manager. It goes straight to the server on this machine, not through Claude Code or the model.</p>
<form method="post"><input type="password" name="token" autocomplete="off" required maxlength="${MAX_TOKEN_CHARS}"><button type="submit">Save token</button></form>`;
const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Saved</title><p>Token saved. You can close this tab and return to Claude Code.</p>';

function reply(res: ServerResponse, status: number, body: string, close = false): void {
  res.writeHead(status, {
    'content-type': body.startsWith('<!doctype') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    // 'same-origin', not 'no-referrer': with no-referrer a browser sends `Origin: null` on the form POST, which handle() refuses.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    ...(close ? { connection: 'close' } : {}),
  });
  res.end(body);
}

/** Collects at most `limit` bytes; calls back with undefined once the body is too large. */
function readBody(req: IncomingMessage, limit: number, done: (body: string | undefined) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk: Buffer) => {
    if (finished) return;
    size += chunk.length;
    if (size > limit) {
      finished = true;
      done(undefined);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!finished) done(Buffer.concat(chunks).toString('utf8'));
  });
}

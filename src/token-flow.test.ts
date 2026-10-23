import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenCollector } from './token-flow.js';

const TOKEN = 'tok_live_0123456789abcdef';
let tokens: TokenCollector;
let received: string[];
let sinkFails: boolean;
const sink = async (token: string) => {
  if (sinkFails) throw new Error(`vault unreachable while sending ${token}`);
  received.push(token);
};
beforeEach(() => {
  received = [];
  sinkFails = false;
  tokens = new TokenCollector({ sink, flowTtlMs: 60_000 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tokens.close();
});

/** True if `needle` is held anywhere reachable from `root` (own properties, Maps, Sets, arrays). */
function holds(root: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof root === 'string') return root.includes(needle);
  if (typeof root !== 'object' || root === null || seen.has(root)) return false;
  seen.add(root);
  const children: unknown[] = root instanceof Map ? [...root.keys(), ...root.values()] : root instanceof Set ? [...root] : Object.values(root);
  return children.some((c) => holds(c, needle, seen));
}

const form = (token: string) => new URLSearchParams({ token }).toString();
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });

/** Sends a request with a chosen Host header, which fetch() will not allow. */
const withHost = (url: string, host: string, method = 'GET') =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

describe('TokenCollector', () => {
  it('start() returns a loopback URL that carries no token', async () => {
    const { url, flowId } = await tokens.start();
    const u = new URL(url);
    expect(u.protocol).toBe('http:');
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.pathname).toMatch(/^\/connect\/[A-Za-z0-9_-]{43}$/);
    expect(u.search).toBe('');
    expect(flowId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(tokens.isConfigured()).toBe(false);
  });

  it('GET serves a password form with no-store caching and a locked-down CSP', async () => {
    const { url } = await tokens.start();
    const res = await fetch(url);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('type="password"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    // Not 'no-referrer': browsers then send `Origin: null` on the same-origin form POST, which the server (rightly) refuses.
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('a valid POST stores the token, completes the flow, and never echoes it', async () => {
    const { url, flowId } = await tokens.start();
    const res = await post(url, form(TOKEN), { origin: new URL(url).origin, 'sec-fetch-site': 'same-origin' });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toContain(TOKEN);
    expect(await tokens.wait(flowId, { timeoutMs: 1000 })).toBe('stored');
    expect(tokens.isConfigured()).toBe(true);
    expect(received).toEqual([TOKEN]);
  });

  it('hands the token to the sink and keeps no copy of it', async () => {
    const { url } = await tokens.start();
    await post(url, form(TOKEN));
    expect(received).toEqual([TOKEN]);
    expect(holds(tokens, TOKEN)).toBe(false);
  });

  it('a failing sink gives a generic 502, leaks nothing, and the same link can be tried again', async () => {
    const { url, flowId } = await tokens.start();
    sinkFails = true;
    const failed = await post(url, form(TOKEN));
    const body = await failed.text();
    expect(failed.status).toBe(502);
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('vault unreachable');
    expect(tokens.isConfigured()).toBe(false);
    sinkFails = false;
    expect((await post(url, form(TOKEN))).status).toBe(200);
    expect(await tokens.wait(flowId, { timeoutMs: 1000 })).toBe('stored');
    expect(received).toEqual([TOKEN]);
  });

  it('a failing sink does not log the token or the sink error message', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { url } = await tokens.start();
    sinkFails = true;
    await post(url, form(TOKEN));
    expect(spies.flatMap((x) => x.mock.calls).flat().join(' ')).not.toContain(TOKEN);
  });

  it('the link works once: a second POST is refused and the stored token is kept', async () => {
    const { url } = await tokens.start();
    expect((await post(url, form(TOKEN))).status).toBe(200);
    expect((await post(url, form('tok_second_attempt'))).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
  });

  it('an unknown nonce is a 404 and the real flow stays pending', async () => {
    const { url, flowId } = await tokens.start();
    const wrong = `${new URL(url).origin}/connect/${'A'.repeat(43)}`;
    expect((await post(wrong, form(TOKEN))).status).toBe(404);
    expect(await tokens.wait(flowId, { timeoutMs: 50 })).toBe('timeout');
    expect(tokens.isConfigured()).toBe(false);
  });

  it('a request whose Host header is not the loopback address and port is refused (DNS rebinding)', async () => {
    const { url } = await tokens.start();
    expect(await withHost(url, 'attacker.example')).toBe(403);
    expect(await withHost(url, `attacker.example:${new URL(url).port}`, 'POST')).toBe(403);
  });

  it('a cross-origin POST is refused and stores nothing', async () => {
    const { url } = await tokens.start();
    const attacks: Array<Record<string, string>> = [{ origin: 'http://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of attacks) {
      expect((await post(url, form(TOKEN), headers)).status).toBe(403);
    }
    expect(tokens.isConfigured()).toBe(false);
    expect(received).toEqual([]);
  });

  it('refuses the wrong content type, an empty token, an oversized body and an oversized token', async () => {
    const { url } = await tokens.start();
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"x"}' })).status).toBe(415);
    expect((await post(url, form(''))).status).toBe(400);
    expect((await post(url, `token=${'a'.repeat(20_000)}`)).status).toBe(413);
    expect((await post(url, form('a'.repeat(4097)))).status).toBe(400);
    expect(tokens.isConfigured()).toBe(false);
    expect(received).toEqual([]);
  });

  it('only GET and POST are served', async () => {
    const { url } = await tokens.start();
    expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(405);
    expect((await fetch(`${new URL(url).origin}/`)).status).toBe(404);
  });

  it('an expired link is refused, and waiting on it times out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const short = new TokenCollector({ sink, flowTtlMs: 1000 });
      const { url, flowId } = await short.start();
      vi.setSystemTime(Date.now() + 2000);
      expect((await post(url, form(TOKEN))).status).toBe(410);
      expect(await short.wait(flowId, { timeoutMs: 20 })).toBe('unknown');
      expect(short.isConfigured()).toBe(false);
      await short.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wait() reports unknown for a flow it never started and timeout for one nobody finishes', async () => {
    const { flowId } = await tokens.start();
    expect(await tokens.wait('no-such-flow', { timeoutMs: 20 })).toBe('unknown');
    expect(await tokens.wait(flowId, { timeoutMs: 30 })).toBe('timeout');
  });

  it('wait() stops early when its signal aborts', async () => {
    const { flowId } = await tokens.start();
    const controller = new AbortController();
    const waiting = tokens.wait(flowId, { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    expect(await waiting).toBe('timeout');
  });

  it('cancel() discards the link so it can no longer be used', async () => {
    const { url, flowId } = await tokens.start();
    tokens.cancel(flowId);
    expect((await post(url, form(TOKEN))).status).toBe(404);
    expect(tokens.isConfigured()).toBe(false);
    expect(received).toEqual([]);
  });

  it('never writes the token to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { url } = await tokens.start();
    await post(url, form(TOKEN));
    expect(spies.flatMap((s) => s.mock.calls).flat().join(' ')).not.toContain(TOKEN);
  });

  it('close() stops listening', async () => {
    const { url } = await tokens.start();
    await tokens.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});

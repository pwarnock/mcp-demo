import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeVault, startFakeVault } from './fake-vault.js';
import { assertSinkUrl, createHttpSink } from './secret-sink.js';

const SECRET = 'tok_live_sink_0123456789';
let vault: FakeVault;
afterEach(() => vault?.close());

describe('createHttpSink', () => {
  it('posts the secret as JSON with a bearer token, and the vault stores it', async () => {
    vault = await startFakeVault();
    await createHttpSink({ url: `${vault.url}/secrets`, authToken: vault.authToken })(SECRET);
    expect(vault.stored()).toEqual([{ name: 'registry-token', length: SECRET.length }]);
  });

  it('throws on a non-2xx answer without the secret or the response body in the message', async () => {
    vault = await startFakeVault();
    const sink = createHttpSink({ url: `${vault.url}/secrets`, authToken: 'wrong' });
    const error = await sink(SECRET).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Secret sink answered 401');
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('throws when the service is unreachable, without the secret in the message', async () => {
    const error = await createHttpSink({ url: 'http://127.0.0.1:1/secrets' })(SECRET).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(SECRET);
  });

  it('does not follow a redirect, so the secret is never re-sent elsewhere', async () => {
    let reachedElsewhere = 0;
    const elsewhere = createHttpServer((_req, res) => {
      reachedElsewhere++;
      res.end();
    });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', () => r()));
    const elsewhereUrl = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}/capture`;
    const redirector = createHttpServer((_req, res) => {
      res.writeHead(307, { location: elsewhereUrl });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(redirector.address() as { port: number }).port}/secrets`;
    await expect(createHttpSink({ url })(SECRET)).rejects.toThrow('Secret sink unreachable');
    expect(reachedElsewhere).toBe(0);
    redirector.close();
    elsewhere.close();
  });

  it('gives up after the timeout when the service never answers', async () => {
    const hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as { port: number }).port;
    const started = Date.now();
    await expect(createHttpSink({ url: `http://127.0.0.1:${port}/secrets`, timeoutMs: 100 })(SECRET)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    hang.close();
  });
});

describe('assertSinkUrl', () => {
  it.each(['https://vault.example.com/v1/secrets', 'http://127.0.0.1:8200/secrets', 'http://localhost:8200/secrets', 'http://[::1]:8200/secrets'])('accepts %s', (url) => {
    expect(() => assertSinkUrl(url)).not.toThrow();
  });

  it.each(['http://vault.example.com/secrets', 'ftp://vault.example.com', 'file:///etc/passwd', 'not a url', 'https://user:pass@vault.example.com/x', ''])(
    'rejects %j',
    (url) => {
      expect(() => assertSinkUrl(url)).toThrow(/SECRET_SINK_URL/);
    },
  );
});

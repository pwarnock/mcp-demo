import type { SecretSink } from './token-flow.js';

const DEFAULT_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Accepts https, or http only on a loopback address, and no credentials in the URL. Returns the parsed URL. */
export function assertSinkUrl(raw: string): URL {
  const problem = new Error('SECRET_SINK_URL must be an https URL (http is allowed only on 127.0.0.1, localhost or [::1]) without credentials');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw problem;
  }
  const safeScheme = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!safeScheme || url.username !== '' || url.password !== '') throw problem;
  return url;
}

/** A sink that POSTs `{ name, value }` as JSON to a secure service. Errors never include the secret or the response body. */
export function createHttpSink(opts: { url: string; authToken?: string; name?: string; timeoutMs?: number }): SecretSink {
  const url = assertSinkUrl(opts.url);
  const name = opts.name ?? 'registry-token';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (secret) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        redirect: 'error', // never follow a redirect with a secret in the body
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', ...(opts.authToken ? { authorization: `Bearer ${opts.authToken}` } : {}) },
        body: JSON.stringify({ name, value: secret }),
      });
    } catch {
      throw new Error('Secret sink unreachable');
    }
    await res.body?.cancel();
    if (!res.ok) throw new Error(`Secret sink answered ${res.status}`);
  };
}

import { afterEach, describe, expect, it } from 'vitest';
import { type FakeVault, startFakeVault } from './fake-vault.js';

const SECRET = 'tok_live_vault_0123456789';
let vault: FakeVault;
afterEach(() => vault.close());

const put = (v: FakeVault, body: string, auth: string | null = v.authToken) =>
  fetch(`${v.url}/secrets`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body });

describe('fake vault', () => {
  it('stores a secret sent with the right bearer token', async () => {
    vault = await startFakeVault();
    expect((await put(vault, JSON.stringify({ name: 'registry-token', value: SECRET }))).status).toBe(201);
    expect(vault.stored()).toEqual([{ name: 'registry-token', length: SECRET.length }]);
  });

  it('answers with whether a secret exists and how long it is, never its value', async () => {
    vault = await startFakeVault();
    await put(vault, JSON.stringify({ name: 'registry-token', value: SECRET }));
    const res = await fetch(`${vault.url}/secrets/registry-token`, { headers: { authorization: `Bearer ${vault.authToken}` } });
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ exists: true, length: SECRET.length });
    expect(body).not.toContain(SECRET);
  });

  it('refuses a missing or wrong bearer token and stores nothing', async () => {
    vault = await startFakeVault();
    const body = JSON.stringify({ name: 'registry-token', value: SECRET });
    expect((await put(vault, body, null)).status).toBe(401);
    expect((await put(vault, body, 'wrong')).status).toBe(401);
    expect(vault.stored()).toEqual([]);
  });

  it('refuses malformed bodies and bad names', async () => {
    vault = await startFakeVault();
    expect((await put(vault, 'not json')).status).toBe(400);
    expect((await put(vault, JSON.stringify({ name: '../x', value: SECRET }))).status).toBe(400);
    expect((await put(vault, JSON.stringify({ name: 'ok', value: '' }))).status).toBe(400);
    expect((await put(vault, JSON.stringify({ name: 'ok', value: 'x'.repeat(10_000) }))).status).toBe(400);
    expect(vault.stored()).toEqual([]);
  });

  it('listens on a requested port', async () => {
    vault = await startFakeVault({ port: 0 });
    expect(new URL(vault.url).port).not.toBe('');
    const chosen = await startFakeVault({ port: Number(new URL(vault.url).port) + 1 }).catch(() => undefined);
    await chosen?.close();
  });

  it('unknown secrets are 404', async () => {
    vault = await startFakeVault();
    expect((await fetch(`${vault.url}/secrets/nope`, { headers: { authorization: `Bearer ${vault.authToken}` } })).status).toBe(404);
  });
});

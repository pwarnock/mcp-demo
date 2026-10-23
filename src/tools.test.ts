import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_ENVIRONMENTS } from './environments.js';
import { createServer } from './server.js';
import type { StateStore } from './store.js';
import { TASKS_EXTENSION } from './tasks.js';
import { TokenCollector } from './token-flow.js';
import { connectModern, tempStore } from './test-helpers.js';
import { deployRelease } from './tools.js';

const KEY = new Uint8Array(32).fill(7);
let store: StateStore;
let tokens: TokenCollector;
let delivered: string[];
let cleanup: () => Promise<void>;
let open: Array<() => Promise<void>> = [];

const connect = async (opts: Parameters<typeof connectModern>[1] = {}, key: Uint8Array = KEY) => {
  const { client, close } = await connectModern(() => createServer({ store, stepDelayMs: 0, requestStateKey: key, tokens, urlWaitMs: 150 }), opts);
  open.push(close);
  return client;
};
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const rollbackArgs = { service: 'web', environment: 'production', toVersion: '1.2.0' };
const accept = { action: 'accept' as const, content: { confirm: true } };

beforeEach(async () => {
  ({ store, cleanup } = await tempStore(2));
  delivered = [];
  tokens = new TokenCollector({ sink: async (secret) => void delivered.push(secret) });
  open = [];
});
afterEach(async () => {
  for (const close of open) await close();
  await tokens.close();
  await cleanup();
});

describe('tools/list', () => {
  it('shows four tools with the declared annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(Object.keys(byName).sort()).toEqual(['deploy_release', 'list_environments', 'rollback_release', 'set_registry_token']);
    expect(byName.list_environments).toMatchObject({ readOnlyHint: true });
    expect(byName.deploy_release).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(byName.rollback_release).toMatchObject({ destructiveHint: true });
  });
});

describe('list_environments', () => {
  it('returns the seed versions', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'list_environments', arguments: {} });
    expect(JSON.parse(text(result))).toEqual(SEED_ENVIRONMENTS);
  });

  it('rejects unknown arguments', async () => {
    const client = await connect();
    expect(isError(await client.callTool({ name: 'list_environments', arguments: { extra: 1 } }))).toBe(true);
  });
});

describe('deploy_release', () => {
  const good = { service: 'web', version: '2.0.0', environment: 'staging' };
  it.each([
    ['an unknown field', { ...good, extra: true }],
    ['a bad service', { ...good, service: '../etc' }],
    ['a bad version', { ...good, version: 'v2' }],
    ['a 33-character version', { ...good, version: `1.${'0'.repeat(31)}` }],
    ['an unknown environment', { ...good, environment: 'qa' }],
    ['an unknown service', { ...good, service: 'billing' }],
  ])('rejects %s and creates no task', async (_name, args) => {
    const client = await connect();
    expect(isError(await client.callTool({ name: 'deploy_release', arguments: args }))).toBe(true);
    expect(store.activeTaskCount()).toBe(0);
  });

  it('a client without the tasks extension gets an isError result and no task is created', async () => {
    const client = await connect({ declareTasks: false });
    const result = await client.callTool({ name: 'deploy_release', arguments: good });
    expect(isError(result)).toBe(true);
    expect(text(result)).toBe('deploy_release needs a client that supports the MCP tasks extension.');
    expect(store.activeTaskCount()).toBe(0);
  });

  const ctxWith = (extensions: object) => ({ mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': { extensions } } } });

  it('a request that declares other extensions but not tasks gets an isError result and no task', () => {
    const result = deployRelease({ store, stepDelayMs: 0 }, good as never, ctxWith({ 'other/ext': {} }));
    expect(isError(result)).toBe(true);
    expect(result).not.toHaveProperty('resultType');
    expect(store.activeTaskCount()).toBe(0);
  });

  it('a tasks-capable request gets a task result and a stored task', async () => {
    const result = deployRelease({ store, stepDelayMs: 0 }, good as never, ctxWith({ [TASKS_EXTENSION]: {} }));
    expect(result).toMatchObject({ resultType: 'task', status: 'working' });
    const id = (result as { taskId: string }).taskId;
    expect(store.getTask(id)).toBeDefined();
    await vi.waitFor(() => expect(store.getTask(id)?.status).toBe('completed'));
  });

  it('answers isError instead of a task when too many deploys are running', async () => {
    const deps = { store, stepDelayMs: 0 };
    const ctx = ctxWith({ [TASKS_EXTENSION]: {} });
    const production = { ...good, environment: 'production' }; // parks at input_required, so the two stay active
    const ids = [deployRelease(deps, production as never, ctx), deployRelease(deps, production as never, ctx)].map((r) => (r as { taskId: string }).taskId);
    const third = deployRelease(deps, production as never, ctx);
    expect(isError(third)).toBe(true);
    expect(text(third)).toBe('Too many deploys are running. Try again when one finishes.');
    expect(store.activeTaskCount()).toBe(2);
    await vi.waitFor(() => expect(ids.map((id) => store.getTask(id)?.status)).toEqual(['input_required', 'input_required']));
  });
});

describe('rollback_release', () => {
  const version = () => store.getEnvironments().production.web;
  type Reply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };

  it('asks for confirmation and changes nothing on the first call', async () => {
    const client = await connect({ onElicit: () => accept });
    const first = (await client.callTool({ name: 'rollback_release', arguments: rollbackArgs }, { allowInputRequired: true } as never)) as unknown as Record<string, unknown>;
    expect(first.resultType).toBe('input_required');
    expect(Object.keys(first.inputRequests as object)).toEqual(['confirm']);
    expect(typeof first.requestState).toBe('string');
    expect(version()).toBe('1.3.0');
  });

  it('acts only after an accepted confirmation', async () => {
    const client = await connect({ onElicit: () => accept });
    const result = await client.callTool({ name: 'rollback_release', arguments: rollbackArgs });
    expect(isError(result)).toBe(false);
    expect(text(result)).toBe('Rolled back web in production to 1.2.0');
    expect(version()).toBe('1.2.0');
  });

  it.each<[string, Reply]>([
    ['declined', { action: 'decline' }],
    ['cancelled', { action: 'cancel' }],
    ['confirm false', { action: 'accept', content: { confirm: false } }],
  ])('a %s confirmation changes nothing', async (_name, reply) => {
    const client = await connect({ onElicit: () => reply });
    const result = await client.callTool({ name: 'rollback_release', arguments: rollbackArgs });
    expect(text(result)).toBe('Rollback cancelled. Nothing was changed.');
    expect(version()).toBe('1.3.0');
  });

  const firstState = async (client: Client, args: Record<string, unknown>) =>
    ((await client.callTool({ name: 'rollback_release', arguments: args }, { allowInputRequired: true } as never)) as unknown as { requestState: string }).requestState;
  const retry = (client: Client, args: Record<string, unknown>, requestState: string) =>
    client.callTool({ name: 'rollback_release', arguments: args, inputResponses: { confirm: accept }, requestState } as never, { allowInputRequired: true } as never);

  it('a tampered requestState is refused with -32602 and nothing changes', async () => {
    const client = await connect({ onElicit: () => accept });
    const state = await firstState(client, rollbackArgs);
    const tampered = `${state.slice(0, -4)}AAAA`;
    await expect(retry(client, rollbackArgs, tampered)).rejects.toMatchObject({ code: -32602 });
    await expect(retry(client, rollbackArgs, state.slice(0, 10))).rejects.toMatchObject({ code: -32602 });
    expect(version()).toBe('1.3.0');
  });

  it('a requestState minted under another key is refused', async () => {
    const other = await connect({ onElicit: () => accept }, new Uint8Array(32).fill(9));
    const foreign = await firstState(other, rollbackArgs);
    const client = await connect({ onElicit: () => accept });
    await expect(retry(client, rollbackArgs, foreign)).rejects.toMatchObject({ code: -32602 });
    expect(version()).toBe('1.3.0');
  });

  it('a requestState minted for one service cannot confirm a rollback of another', async () => {
    const client = await connect({ onElicit: () => accept });
    const stateForWeb = await firstState(client, rollbackArgs);
    const result = (await retry(client, { ...rollbackArgs, service: 'api' }, stateForWeb)) as unknown as Record<string, unknown>;
    expect(result.resultType).toBe('input_required');
    expect(store.getEnvironments().production.api).toBe('1.3.0');
  });

  it('an accepted confirmation without any requestState is asked again, not acted on', async () => {
    const client = await connect({ onElicit: () => accept });
    const result = (await client.callTool({ name: 'rollback_release', arguments: rollbackArgs, inputResponses: { confirm: accept } } as never, { allowInputRequired: true } as never)) as unknown as Record<string, unknown>;
    expect(result.resultType).toBe('input_required');
    expect(version()).toBe('1.3.0');
  });

  it('a storage failure is logged to stderr and the client gets a generic message without paths', async () => {
    const client = await connect({ onElicit: () => accept });
    vi.spyOn(store, 'setVersion').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, open /secret/path/state.json.1.tmp');
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await client.callTool({ name: 'rollback_release', arguments: rollbackArgs });
    expect(isError(result)).toBe(true);
    expect(text(result)).toBe('Rollback failed.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rollback_release'), expect.stringContaining('/secret/path'));
    log.mockRestore();
  });

  it('a replayed requestState with the same arguments is accepted within its lifetime and only repeats the confirmed rollback', async () => {
    const client = await connect({ onElicit: () => accept });
    const state = await firstState(client, rollbackArgs);
    for (let i = 0; i < 2; i++) {
      const result = await retry(client, rollbackArgs, state);
      expect(text(result)).toBe('Rolled back web in production to 1.2.0');
    }
    expect(version()).toBe('1.2.0');
    expect(store.getEnvironments().production.api).toBe('1.3.0');
  });

  it('rejects an unknown service, a bad version and unknown fields', async () => {
    const client = await connect({ onElicit: () => accept });
    for (const args of [{ ...rollbackArgs, service: 'billing' }, { ...rollbackArgs, toVersion: 'latest' }, { ...rollbackArgs, extra: 1 }]) {
      expect(isError(await client.callTool({ name: 'rollback_release', arguments: args }))).toBe(true);
    }
    expect(version()).toBe('1.3.0');
  });
});

describe('set_registry_token (URL-mode elicitation)', () => {
  const TOKEN = 'tok_live_0123456789abcdef';
  type Reply = { action: 'accept' | 'decline' | 'cancel' };
  const submit = async (url: string) => {
    expect((await fetch(url)).status).toBe(200);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: TOKEN }) });
    expect(res.status).toBe(200);
  };
  const ask = (client: Client) =>
    client.callTool({ name: 'set_registry_token', arguments: {} }, { allowInputRequired: true } as never) as unknown as Promise<Record<string, any>>;
  const retry = (client: Client, requestState: string, reply: Reply = { action: 'accept' }, name = 'set_registry_token') =>
    client.callTool({ name, arguments: {}, inputResponses: { open_link: reply }, requestState } as never, { allowInputRequired: true } as never) as unknown as Promise<Record<string, any>>;

  it('the first call returns a URL-mode request for a loopback page and a sealed requestState, and stores nothing', async () => {
    const client = await connect({ onElicit: () => accept });
    const first = await ask(client);
    expect(first.resultType).toBe('input_required');
    expect(first.inputRequests.open_link.params).toMatchObject({ mode: 'url', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/connect\/[A-Za-z0-9_-]{43}$/) });
    expect(typeof first.requestState).toBe('string');
    expect(JSON.stringify(first)).not.toContain(TOKEN);
    expect(tokens.isConfigured()).toBe(false);
  });

  it('after the user submits the page, the tool reports the token saved without ever showing it', async () => {
    const seen: string[] = [];
    const client = await connect({
      onElicit: async (req) => {
        seen.push(req.message, req.url ?? '');
        await submit(req.url as string);
        return { action: 'accept' };
      },
    });
    const result = await client.callTool({ name: 'set_registry_token', arguments: {} });
    expect(isError(result)).toBe(false);
    expect(text(result)).toBe('Registry token saved. It was not shown to the model.');
    expect(tokens.isConfigured()).toBe(true);
    expect(delivered).toEqual([TOKEN]);
    expect([...seen, JSON.stringify(result)].join(' ')).not.toContain(TOKEN);
  });

  it.each<[string, Reply]>([
    ['declined', { action: 'decline' }],
    ['cancelled', { action: 'cancel' }],
  ])('a %s request stores nothing and kills the link', async (_name, reply) => {
    let link = '';
    const client = await connect({ onElicit: (req) => { link = req.url as string; return reply; } });
    const result = await client.callTool({ name: 'set_registry_token', arguments: {} });
    expect(text(result)).toBe('Cancelled. No token was stored.');
    expect(tokens.isConfigured()).toBe(false);
    expect((await fetch(link)).status).toBe(404);
  });

  it('accepting without submitting the page times out and kills the link', async () => {
    let link = '';
    const client = await connect({ onElicit: (req) => { link = req.url as string; return accept; } });
    const result = await client.callTool({ name: 'set_registry_token', arguments: {} });
    expect(isError(result)).toBe(true);
    expect(text(result)).toBe('Timed out waiting for the token page to be submitted.');
    expect((await fetch(link)).status).toBe(404);
    expect(tokens.isConfigured()).toBe(false);
  });

  it('a client that only declares form elicitation is refused before any link is opened', async () => {
    const client = await connect({ onElicit: () => accept, elicitationModes: ['form'] });
    const result = await client.callTool({ name: 'set_registry_token', arguments: {} });
    expect(isError(result)).toBe(true);
    expect(text(result)).toBe('set_registry_token needs a client that supports URL-mode elicitation.');
    expect(tokens.activeFlowCount()).toBe(0);
  });

  it('a tampered requestState is refused with -32602 and stores nothing', async () => {
    const client = await connect({ onElicit: () => accept });
    const first = await ask(client);
    const state = first.requestState as string;
    await expect(retry(client, `${state.slice(0, -4)}AAAA`)).rejects.toMatchObject({ code: -32602 });
    expect(tokens.isConfigured()).toBe(false);
  });

  it('a requestState from rollback_release cannot continue a token flow', async () => {
    const client = await connect({ onElicit: () => accept });
    const rollbackState = ((await client.callTool({ name: 'rollback_release', arguments: rollbackArgs }, { allowInputRequired: true } as never)) as unknown as { requestState: string }).requestState;
    const result = await retry(client, rollbackState);
    expect(result.resultType).toBe('input_required');
    expect(tokens.isConfigured()).toBe(false);
  });

  it('a flow that no longer exists is replaced by a fresh link instead of failing', async () => {
    const client = await connect({ onElicit: () => accept });
    const first = await ask(client);
    await tokens.close();
    const again = await retry(client, first.requestState);
    expect(again.resultType).toBe('input_required');
    expect(again.inputRequests.open_link.params.url).not.toBe(first.inputRequests.open_link.params.url);
  });

  it('is listed with honest annotations and no input fields', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'set_registry_token');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(isError(await client.callTool({ name: 'set_registry_token', arguments: { token: TOKEN } }))).toBe(true);
  });
});

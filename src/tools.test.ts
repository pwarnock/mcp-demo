import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_ENVIRONMENTS } from './environments.js';
import { createServer } from './server.js';
import type { StateStore } from './store.js';
import { TASKS_EXTENSION } from './tasks.js';
import { connectModern, tempStore } from './test-helpers.js';
import { deployRelease } from './tools.js';

const KEY = new Uint8Array(32).fill(7);
let store: StateStore;
let cleanup: () => Promise<void>;
let open: Array<() => Promise<void>> = [];

const connect = async (opts: Parameters<typeof connectModern>[1] = {}, key: Uint8Array = KEY) => {
  const { client, close } = await connectModern(() => createServer({ store, stepDelayMs: 0, requestStateKey: key }), opts);
  open.push(close);
  return client;
};
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const rollbackArgs = { service: 'web', environment: 'production', toVersion: '1.2.0' };
const accept = { action: 'accept' as const, content: { confirm: true } };

beforeEach(async () => {
  ({ store, cleanup } = await tempStore(2));
  open = [];
});
afterEach(async () => {
  for (const close of open) await close();
  await cleanup();
});

describe('tools/list', () => {
  it('shows three tools with the declared annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(Object.keys(byName).sort()).toEqual(['deploy_release', 'list_environments', 'rollback_release']);
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

  it('a tasks-capable request gets a task result and a stored task', async () => {
    const result = deployRelease({ store, stepDelayMs: 0, requestStateKey: KEY }, good as never, ctxWith({ [TASKS_EXTENSION]: {} }));
    expect(result).toMatchObject({ resultType: 'task', status: 'working' });
    const id = (result as { taskId: string }).taskId;
    expect(store.getTask(id)).toBeDefined();
    await vi.waitFor(() => expect(store.getTask(id)?.status).toBe('completed'));
  });

  it('answers isError instead of a task when too many deploys are running', async () => {
    const deps = { store, stepDelayMs: 0, requestStateKey: KEY };
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

  it('rejects an unknown service, a bad version and unknown fields', async () => {
    const client = await connect({ onElicit: () => accept });
    for (const args of [{ ...rollbackArgs, service: 'billing' }, { ...rollbackArgs, toVersion: 'latest' }, { ...rollbackArgs, extra: 1 }]) {
      expect(isError(await client.callTool({ name: 'rollback_release', arguments: args }))).toBe(true);
    }
    expect(version()).toBe('1.3.0');
  });
});

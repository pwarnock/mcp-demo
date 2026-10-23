// Test-only helpers. Nothing in src/ imports this file except tests.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './store.js';
import { TASKS_EXTENSION } from './tasks.js';

export async function tempStore(maxActiveTasks = 8): Promise<{ store: StateStore; path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'release-manager-test-'));
  const path = join(dir, 'state.json');
  return { store: new StateStore({ path, maxActiveTasks }), path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Serves `factory()` over an in-memory pair on the 2026-07-28 protocol and returns a connected client. */
export async function connectModern(
  factory: () => McpServer,
  opts: { declareTasks?: boolean; onElicit?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> } } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { legacy: 'reject', transport: serverTransport });
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    {
      capabilities: {
        ...(opts.declareTasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }),
        ...(opts.onElicit ? { elicitation: { form: {} } } : {}),
      },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    } as never,
  );
  const onElicit = opts.onElicit;
  if (onElicit) client.setRequestHandler('elicitation/create', async (request) => onElicit((request.params as { message: string }).message));
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await handle.close(); } };
}

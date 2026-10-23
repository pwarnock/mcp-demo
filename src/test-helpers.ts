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

type ElicitReply = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> };
export interface ElicitRequest {
  mode: 'form' | 'url';
  message: string;
  url?: string;
}

/** Serves `factory()` over an in-memory pair on the 2026-07-28 protocol and returns a connected client. */
export async function connectModern(
  factory: () => McpServer,
  opts: { declareTasks?: boolean; onElicit?: (req: ElicitRequest) => ElicitReply | Promise<ElicitReply>; elicitationModes?: Array<'form' | 'url'> } = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { legacy: 'reject', transport: serverTransport });
  const modes = opts.elicitationModes ?? ['form', 'url'];
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    {
      capabilities: {
        ...(opts.declareTasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } }),
        ...(opts.onElicit ? { elicitation: Object.fromEntries(modes.map((m) => [m, {}])) } : {}),
      },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    } as never,
  );
  const onElicit = opts.onElicit;
  if (onElicit) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as { mode?: 'form' | 'url'; message: string; url?: string };
      return onElicit({ mode: params.mode ?? 'form', message: params.message, ...(params.url === undefined ? {} : { url: params.url }) });
    });
  }
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await handle.close(); } };
}

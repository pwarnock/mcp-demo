// THROWAWAY spike driver: talks to server.ts via the SDK client.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

const transport = new StdioClientTransport({ command: 'bun', args: ['spikes/tasks/server.ts'] });
const client = new Client(
  { name: 'drive', version: '0.0.0' },
  { capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } as never, versionNegotiation: { mode: { pin: '2026-07-28' } } } as never,
);
const Any = z.object({}).passthrough();
const step = async (label: string, fn: () => Promise<unknown>) => {
  try { console.log(label, JSON.stringify(await fn())); } catch (e) { console.log(label, 'ERROR', String(e)); }
};
await client.connect(transport);
console.log('server caps', JSON.stringify(client.getServerCapabilities()));
await step('tools/call', () => client.callTool({ name: 'slow', arguments: {} }));
await step('tasks/get', () => client.request({ method: 'tasks/get', params: { taskId: 't1' } } as never, Any as never));
await step('tasks/update', () => client.request({ method: 'tasks/update', params: { taskId: 't1', inputResponses: {} } } as never, Any as never));
await step('tasks/cancel', () => client.request({ method: 'tasks/cancel', params: { taskId: 't1' } } as never, Any as never));
await client.close();

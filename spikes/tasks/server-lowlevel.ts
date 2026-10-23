// THROWAWAY spike: same, but tools/call and tools/list registered at the low level.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const now = () => new Date().toISOString();
serveStdio(
  () => {
    const mcp = new McpServer({ name: 'tasks-spike-low', version: '0.0.0' }, { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } as never });
    mcp.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'slow', description: 'spike', inputSchema: { type: 'object', properties: {} } }] }) as never);
    mcp.server.setRequestHandler('tools/call', async () => ({ resultType: 'task', taskId: 't1', status: 'working', createdAt: now(), lastUpdatedAt: now(), ttlMs: null, pollIntervalMs: 500 }) as never);
    return mcp;
  },
  { legacy: 'reject', onerror: (e) => console.error('[spike] onerror', String(e)) },
);

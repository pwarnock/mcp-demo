// THROWAWAY spike: can SDK 2.4.0 serve the MCP tasks extension? See docs/superpowers/spikes.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const log = (...a: unknown[]) => console.error('[spike]', ...a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
const now = () => new Date().toISOString();
const task = (status: string, extra: object = {}) => ({
  taskId: 't1', status, createdAt: now(), lastUpdatedAt: now(), ttlMs: null, pollIntervalMs: 500, ...extra,
});

serveStdio(
  () => {
    const mcp = new McpServer(
      { name: 'tasks-spike', version: '0.0.0' },
      { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } as never },
    );
    mcp.registerTool('slow', { description: 'spike', inputSchema: z.object({}) }, async (_args, ctx) => {
      log('tools/call envelope', ctx.mcpReq.envelope ?? null);
      return { resultType: 'task', ...task('working') } as never;
    });
    const Params = z.object({ taskId: z.string() }).passthrough();
    const Any = z.object({}).passthrough();
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      mcp.server.setRequestHandler(method, { params: Params, result: Any }, async (params, ctx) => {
        log(method, params, ctx.mcpReq.envelope ?? null);
        return method === 'tasks/get' ? { resultType: 'complete', ...task('completed', { result: { content: [{ type: 'text', text: 'done' }] } }) } : {};
      });
    }
    return mcp;
  },
  { legacy: 'reject', onerror: (e) => log('onerror', String(e)) },
);

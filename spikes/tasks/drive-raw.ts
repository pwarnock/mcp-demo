// THROWAWAY spike: raw JSON-RPC over stdio to see exactly what the server writes.
import { spawn } from 'node:child_process';
const child = spawn('bun', ['spikes/tasks/server.ts'], { stdio: ['pipe', 'pipe', 'inherit'] });
const meta = (withTasks: boolean) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': withTasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {},
});
const send = (id: number, method: string, params: object, withTasks = true) =>
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta(withTasks) } }) + '\n');
let buf = '';
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { console.log('WIRE <-', buf.slice(0, i)); buf = buf.slice(i + 1); } });
send(1, 'server/discover', {});
setTimeout(() => send(2, 'tools/call', { name: 'slow', arguments: {} }), 300);
setTimeout(() => send(3, 'tasks/get', { taskId: 't1' }), 600);
setTimeout(() => send(4, 'tasks/get', {}), 900);
setTimeout(() => child.kill(), 1500);

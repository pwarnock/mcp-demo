import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Json = Record<string, any>;

class Wire {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (m: Json) => void>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private buf = '';

  constructor(statePath: string) {
    this.child = spawn('bun', ['src/main.ts'], {
      env: { ...process.env, STATE_PATH: statePath, STEP_DELAY_MS: '0', REQUEST_STATE_KEY: 'ab'.repeat(32) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.stdout.push(line);
        const msg = JSON.parse(line) as Json;
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
    this.exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stderr.on('data', (d: Buffer) => this.stderr.push(d.toString()));
  }

  request(method: string, params: Json = {}, tasks = true, extraCaps: Json = {}): Promise<Json> {
    const id = this.nextId++;
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': { ...(tasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}), ...extraCaps },
    };
    const reply = new Promise<Json>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 8000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } })}\n`);
    return reply;
  }

  async stop(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }
}

let dir: string;
let statePath: string;
let wires: Wire[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'release-manager-e2e-'));
  statePath = join(dir, 'state.json');
  wires = [];
});
afterEach(async () => {
  await Promise.all(wires.map((w) => w.stop()));
  await rm(dir, { recursive: true, force: true });
});
const start = () => {
  const w = new Wire(statePath);
  wires.push(w);
  return w;
};
const deploy = (w: Wire, environment: string) =>
  w.request('tools/call', { name: 'deploy_release', arguments: { service: 'web', version: '2.0.0', environment } });
const status = async (w: Wire, taskId: string) => (await w.request('tasks/get', { taskId })).result as Json;
const reach = (w: Wire, taskId: string, want: string) => vi.waitFor(async () => expect((await status(w, taskId)).status).toBe(want), { timeout: 5000 });

describe('stdio server', () => {
  it('a staging deploy reaches completed over stdio, and every stdout line is valid JSON-RPC', async () => {
    const w = start();
    const discover = await w.request('server/discover');
    expect(discover.result.supportedVersions).toContain('2026-07-28');
    expect(discover.result.capabilities.extensions).toHaveProperty('io.modelcontextprotocol/tasks');
    const created = (await deploy(w, 'staging')).result;
    expect(created).toMatchObject({ resultType: 'task', status: 'working' });
    await reach(w, created.taskId, 'completed');
    const done = await status(w, created.taskId);
    expect(done).toMatchObject({ resultType: 'complete', result: { content: [{ type: 'text', text: 'Deployed web 2.0.0 to staging' }] } });
    expect(w.stdout.length).toBeGreaterThan(3);
    for (const line of w.stdout) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  });

  it('a client that did not declare the tasks extension gets an error result, not a task', async () => {
    const w = start();
    const reply = await w.request('tools/call', { name: 'deploy_release', arguments: { service: 'web', version: '2.0.0', environment: 'staging' } }, false);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.resultType).not.toBe('task');
  });

  it('a production deploy reaches input_required, then completes after tasks/update', async () => {
    const w = start();
    const { taskId } = (await deploy(w, 'production')).result;
    await reach(w, taskId, 'input_required');
    const waiting = await status(w, taskId);
    expect(waiting.inputRequests.approve).toMatchObject({ method: 'elicitation/create', params: { mode: 'form' } });
    await w.request('tasks/update', { taskId, inputResponses: { approve: { action: 'accept', content: { approve: true } } } });
    await reach(w, taskId, 'completed');
  });

  it('set_registry_token sends a URL-mode request over the wire and finishes once the page is submitted, never exposing the token', async () => {
    const TOKEN = 'tok_live_e2e_0123456789';
    const w = start();
    const caps = { elicitation: { form: {}, url: {} } };
    const call = (extra: Json = {}) => w.request('tools/call', { name: 'set_registry_token', arguments: {}, ...extra }, true, caps);
    const first = (await call()).result;
    expect(first.resultType).toBe('input_required');
    const link = first.inputRequests.open_link;
    expect(link).toMatchObject({ method: 'elicitation/create', params: { mode: 'url', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/connect\//) } });
    expect(typeof first.requestState).toBe('string');
    const page = await fetch(link.params.url);
    expect(page.status).toBe(200);
    const saved = await fetch(link.params.url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: TOKEN }) });
    expect(saved.status).toBe(200);
    const done = (await call({ inputResponses: { open_link: { action: 'accept' } }, requestState: first.requestState })).result;
    expect(done.content[0].text).toBe('Registry token saved for this session. It was not shown to the model or written to disk.');
    expect([...w.stdout, ...w.stderr].join('\n')).not.toContain(TOKEN);
  });

  it('an unknown taskId yields -32602 over the wire', async () => {
    const w = start();
    expect((await w.request('tasks/get', { taskId: 'nope' })).error.code).toBe(-32602);
  });

  it('a finished task is still answerable after the server process restarts, and an unfinished one reports failed', async () => {
    const first = start();
    const finished = (await deploy(first, 'staging')).result.taskId;
    await reach(first, finished, 'completed');
    const parked = (await deploy(first, 'production')).result.taskId;
    await reach(first, parked, 'input_required');
    await first.stop();

    const second = start();
    expect(await status(second, finished)).toMatchObject({ status: 'completed' });
    expect(await status(second, parked)).toMatchObject({ status: 'failed', error: { code: -32603, message: 'Server restarted before the task finished' } });
  });

  it('writes nothing but protocol messages to stdout; diagnostics go to stderr', async () => {
    const w = start();
    await w.request('server/discover');
    expect(w.stdout.every((l) => l.startsWith('{"'))).toBe(true);
    expect(w.stderr.join('')).not.toContain('ab'.repeat(32));
  });
});

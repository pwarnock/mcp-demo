import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEED_ENVIRONMENTS } from './environments.js';
import { StateStore, TooManyTasksError } from './store.js';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-test-'));
  path = join(dir, 'state.json');
});

const open = (extra: { maxActiveTasks?: number; now?: () => number } = {}) =>
  new StateStore({ path, maxActiveTasks: extra.maxActiveTasks ?? 8, now: extra.now });

describe('StateStore', () => {
  it('a new store starts from the seed environments', () => {
    expect(open().getEnvironments()).toEqual(SEED_ENVIRONMENTS);
  });

  it('setVersion survives reopening the store', () => {
    open().setVersion('staging', 'web', '1.9.9');
    expect(open().getEnvironments().staging.web).toBe('1.9.9');
  });

  it('a finished task created in one store instance is found in a second instance on the same file', () => {
    const first = open();
    const task = first.createTask({});
    first.updateTask(task.taskId, { status: 'completed', result: { content: [] } });
    expect(open().getTask(task.taskId)?.status).toBe('completed');
  });

  it('a working task becomes failed when the store is reopened', () => {
    const task = open().createTask({});
    const reopened = open().getTask(task.taskId);
    expect(reopened?.status).toBe('failed');
    expect(reopened?.error).toEqual({ code: -32603, message: 'Server restarted before the task finished' });
  });

  it('createTask throws TooManyTasksError at maxActiveTasks, and succeeds again after one task completes', () => {
    const store = open({ maxActiveTasks: 2 });
    const a = store.createTask({});
    store.createTask({});
    expect(() => store.createTask({})).toThrow(TooManyTasksError);
    store.updateTask(a.taskId, { status: 'completed' });
    expect(() => store.createTask({})).not.toThrow();
  });

  it('new tasks have a printable taskId, one hour ttl and a 1000 ms poll interval', () => {
    const task = open().createTask({ statusMessage: 'Starting' });
    expect(task.taskId).toMatch(/^[\x21-\x7e]{1,128}$/);
    expect(task).toMatchObject({ status: 'working', ttlMs: 3_600_000, pollIntervalMs: 1000, statusMessage: 'Starting' });
  });

  it('getTask returns undefined for an unknown id', () => {
    expect(open().getTask('nope')).toBeUndefined();
  });

  it('a terminal task ignores further updates', () => {
    const store = open();
    const task = store.createTask({});
    store.updateTask(task.taskId, { status: 'cancelled' });
    store.updateTask(task.taskId, { status: 'completed' });
    expect(store.getTask(task.taskId)?.status).toBe('cancelled');
  });

  it('a completed task older than its ttlMs is gone, and a younger one is kept', () => {
    let clock = 1_000_000;
    const store = open({ now: () => clock });
    const old = store.createTask({});
    store.updateTask(old.taskId, { status: 'completed' });
    clock += 3_600_001 - 1000;
    const young = store.createTask({});
    store.updateTask(young.taskId, { status: 'completed' });
    clock += 1000;
    expect(store.getTask(old.taskId)).toBeUndefined();
    expect(store.getTask(young.taskId)?.status).toBe('completed');
    expect(open({ now: () => clock }).getTask(old.taskId)).toBeUndefined();
  });

  it('a corrupt state file throws an error that does not include the file contents', async () => {
    await writeFile(path, 'TOPSECRET{{not json');
    expect(() => open()).toThrow(/corrupt/i);
    try {
      open();
    } catch (e) {
      expect(String(e)).not.toContain('TOPSECRET');
    }
  });

  it('writes leave no temporary files behind', async () => {
    const store = open();
    store.setVersion('dev', 'web', '2.0.0');
    store.createTask({});
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});

describe('StateStore with hostile keys', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('getTask(%j) is unknown, not an inherited object', (id) => {
    expect(open().getTask(id)).toBeUndefined();
  });

  it('updateTask on __proto__ throws and never touches Object.prototype', () => {
    const store = open();
    expect(() => store.updateTask('__proto__', { status: 'completed' })).toThrow('Unknown task');
    expect(({} as { status?: string }).status).toBeUndefined();
  });

  it('setVersion refuses unknown environments and invalid service names', () => {
    const store = open();
    expect(() => store.setVersion('__proto__' as never, 'web', '1.0.0')).toThrow();
    expect(() => store.setVersion('qa' as never, 'web', '1.0.0')).toThrow();
    expect(() => store.setVersion('staging', '__proto__', '1.0.0')).toThrow();
    expect(() => store.setVersion('staging', 'web', 'not-a-version')).toThrow();
    expect(({} as { web?: string }).web).toBeUndefined();
    expect(store.getEnvironments()).toEqual(SEED_ENVIRONMENTS);
  });

  it('a state file with a __proto__ task key loads without polluting anything', async () => {
    await writeFile(path, '{"environments":' + JSON.stringify(SEED_ENVIRONMENTS) + ',"tasks":{"__proto__":{"status":"completed","polluted":true}}}');
    const store = open();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(store.activeTaskCount()).toBe(0);
  });
});

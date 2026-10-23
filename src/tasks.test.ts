import { McpServer } from '@modelcontextprotocol/server';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { answerApproval, cancelDeploy, startDeploy } from './deploy.js';
import type { StateStore, TaskRecord } from './store.js';
import { TASKS_EXTENSION, clientSupportsTasks, registerTasksExtension, toCreateTaskResult, toGetTaskResult } from './tasks.js';
import { connectModern, tempStore } from './test-helpers.js';

const base: TaskRecord = {
  taskId: 'abc', status: 'working', createdAt: '2026-10-23T00:00:00.000Z', lastUpdatedAt: '2026-10-23T00:00:01.000Z', ttlMs: 3_600_000, pollIntervalMs: 1000,
};
const keys = (o: object) => Object.keys(o).sort();
const expected = (...extra: string[]) => [...coreKeys, ...extra].sort();
const coreKeys = ['createdAt', 'lastUpdatedAt', 'pollIntervalMs', 'status', 'taskId', 'ttlMs'];

describe('toCreateTaskResult', () => {
  it('has exactly the documented task fields and resultType task', () => {
    const result = toCreateTaskResult(base);
    expect(keys(result)).toEqual(expected('resultType'));
    expect(result).toMatchObject({ resultType: 'task', taskId: 'abc', status: 'working', ttlMs: 3_600_000 });
  });

  it('includes statusMessage only when set, and passes a null ttlMs through', () => {
    expect(keys(toCreateTaskResult({ ...base, statusMessage: 'Step 1 of 4: validate', ttlMs: null }))).toEqual(expected('resultType', 'statusMessage'));
    expect(toCreateTaskResult({ ...base, ttlMs: null })).toMatchObject({ ttlMs: null });
  });
});

describe('toGetTaskResult', () => {
  it('a working task has no result, error or inputRequests', () => {
    const result = toGetTaskResult(base);
    expect(keys(result)).toEqual(expected('resultType'));
    expect(result).toMatchObject({ resultType: 'complete' });
  });

  it('result appears only when completed, error only when failed, inputRequests only when input_required', () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const error = { code: -32603, message: 'boom' };
    const inputRequests = { approve: { method: 'elicitation/create' as const, params: {} } };
    const stray = { result, error, inputRequests };
    expect(toGetTaskResult({ ...base, status: 'completed', ...stray })).toMatchObject({ result });
    expect(keys(toGetTaskResult({ ...base, status: 'completed', ...stray }))).toEqual(expected('result', 'resultType'));
    expect(keys(toGetTaskResult({ ...base, status: 'failed', ...stray }))).toEqual(expected('error', 'resultType'));
    expect(keys(toGetTaskResult({ ...base, status: 'input_required', ...stray }))).toEqual(expected('inputRequests', 'resultType'));
    expect(keys(toGetTaskResult({ ...base, status: 'cancelled', ...stray }))).toEqual(expected('resultType'));
  });
});

describe('clientSupportsTasks', () => {
  const ctx = (envelope?: Record<string, unknown>) => ({ mcpReq: { envelope } });
  const caps = (c: unknown) => ctx({ 'io.modelcontextprotocol/clientCapabilities': c });

  it('is true when the request declares the tasks extension', () => {
    expect(clientSupportsTasks(caps({ extensions: { [TASKS_EXTENSION]: {} } }))).toBe(true);
  });

  it.each([
    ['no envelope', ctx()],
    ['empty capabilities', caps({})],
    ['extensions without tasks', caps({ extensions: { 'other/ext': {} } })],
    ['extensions not an object', caps({ extensions: 'tasks' })],
    ['capabilities null', caps(null)],
  ])('is false for %s', (_name, c) => {
    expect(clientSupportsTasks(c)).toBe(false);
  });
});

describe('tasks handlers', () => {
  let store: StateStore;
  let cleanup: () => Promise<void>;
  let client: Client;
  let close: () => Promise<void>;
  const Any = z.object({}).passthrough();
  const call = (method: string, params: object) => client.request({ method, params } as never, Any as never) as Promise<Record<string, unknown>>;

  beforeEach(async () => {
    ({ store, cleanup } = await tempStore());
    ({ client, close } = await connectModern(() => {
      const mcp = new McpServer({ name: 'tasks-test', version: '0.0.0' }, { capabilities: { tools: {} } });
      registerTasksExtension(mcp, store, {
        onUpdate: (task, inputResponses) => answerApproval(store, task.taskId, inputResponses),
        onCancel: (task) => cancelDeploy(store, task.taskId),
      });
      return mcp;
    }));
  });
  afterEach(async () => {
    await close();
    await cleanup();
  });

  const production = () => startDeploy(store, { service: 'web', version: '2.0.0', environment: 'production' }, { stepDelayMs: 0 });
  const awaitInput = (id: string) => vi.waitFor(() => expect(store.getTask(id)?.status).toBe('input_required'));

  it('advertises the tasks extension', () => {
    expect(client.getServerCapabilities()).toMatchObject({ extensions: { [TASKS_EXTENSION]: {} } });
  });

  it('tasks/get returns the stored task', async () => {
    const task = store.createTask({ statusMessage: 'hello' });
    const result = await call('tasks/get', { taskId: task.taskId });
    // The SDK client strips resultType from results; the wire value is pinned by the toGetTaskResult tests and the stdio e2e test.
    expect(result).toMatchObject({ taskId: task.taskId, status: 'working', statusMessage: 'hello', ttlMs: 3_600_000 });
  });

  it.each(['tasks/get', 'tasks/update', 'tasks/cancel'])('%s with an unknown taskId yields -32602', async (method) => {
    await expect(call(method, { taskId: 'does-not-exist' })).rejects.toMatchObject({ code: -32602 });
  });

  it.each([['empty', ''], ['too long', 'a'.repeat(129)], ['contains a space', 'a b'], ['__proto__', '__proto__'], ['constructor', 'constructor']])(
    'tasks/get with a %s taskId yields -32602',
    async (_name, taskId) => {
      await expect(call('tasks/get', { taskId })).rejects.toMatchObject({ code: -32602 });
    },
  );

  it('tasks/get without a taskId yields -32602', async () => {
    await expect(call('tasks/get', {})).rejects.toMatchObject({ code: -32602 });
  });

  it('tasks/update delivers the answer, returns an empty result, and the deploy completes', async () => {
    const task = production();
    await awaitInput(task.taskId);
    const result = await call('tasks/update', { taskId: task.taskId, inputResponses: { approve: { action: 'accept', content: { approve: true } } } });
    expect(keys(result).filter((k) => k !== '_meta')).toEqual([]);
    await vi.waitFor(() => expect(store.getTask(task.taskId)?.status).toBe('completed'));
  });

  it('tasks/update for a key that is not outstanding, or a malformed answer, is acknowledged and changes nothing', async () => {
    const task = production();
    await awaitInput(task.taskId);
    for (const inputResponses of [{ other: { action: 'accept', content: { approve: true } } }, { approve: 'yes' }, {}]) {
      await call('tasks/update', { taskId: task.taskId, inputResponses });
      expect(store.getTask(task.taskId)?.status).toBe('input_required');
    }
  });

  it('tasks/update with more than 16 keys yields -32602', async () => {
    const task = production();
    await awaitInput(task.taskId);
    const inputResponses = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, {}]));
    await expect(call('tasks/update', { taskId: task.taskId, inputResponses })).rejects.toMatchObject({ code: -32602 });
  });

  it('tasks/cancel ends a deploy that is waiting for approval', async () => {
    const task = production();
    await awaitInput(task.taskId);
    await call('tasks/cancel', { taskId: task.taskId });
    await vi.waitFor(() => expect(store.getTask(task.taskId)?.status).toBe('cancelled'));
  });

  it('tasks/cancel on a terminal task is acknowledged and the status does not change', async () => {
    const task = store.createTask({});
    store.updateTask(task.taskId, { status: 'completed' });
    await call('tasks/cancel', { taskId: task.taskId });
    expect(store.getTask(task.taskId)?.status).toBe('completed');
  });
});

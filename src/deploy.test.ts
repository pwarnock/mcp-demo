import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerApproval, cancelDeploy, startDeploy } from './deploy.js';
import { tempStore } from './test-helpers.js';
import type { StateStore } from './store.js';

let store: StateStore;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ store, cleanup } = await tempStore()));
afterEach(() => cleanup());

const status = (id: string) => store.getTask(id)?.status;
const reach = (id: string, want: string) => vi.waitFor(() => expect(status(id)).toBe(want));
const staging = { service: 'web', version: '2.0.0', environment: 'staging' as const };
const production = { service: 'web', version: '2.0.0', environment: 'production' as const };
const accept = { approve: { action: 'accept', content: { approve: true } } };

describe('startDeploy', () => {
  it('a staging deploy goes working then completed and sets the version', async () => {
    const task = startDeploy(store, staging, { stepDelayMs: 0 });
    expect(task.status).toBe('working');
    await reach(task.taskId, 'completed');
    expect(store.getEnvironments().staging.web).toBe('2.0.0');
    expect(store.getTask(task.taskId)?.result).toEqual({
      content: [{ type: 'text', text: 'Deployed web 2.0.0 to staging' }],
    });
  });

  it('statusMessage names the current step', async () => {
    const task = startDeploy(store, staging, { stepDelayMs: 30 });
    const seen = new Set<string>();
    await vi.waitFor(() => {
      const m = store.getTask(task.taskId)?.statusMessage;
      if (m) seen.add(m);
      expect(status(task.taskId)).toBe('completed');
    }, { timeout: 2000, interval: 5 });
    expect(seen).toContain('Step 1 of 4: validate');
    expect(seen).toContain('Step 4 of 4: rollout');
  });

  it('a production deploy stops at input_required with an approve request', async () => {
    const task = startDeploy(store, production, { stepDelayMs: 0 });
    await reach(task.taskId, 'input_required');
    const request = store.getTask(task.taskId)?.inputRequests?.approve;
    expect(request?.method).toBe('elicitation/create');
    expect(request?.params).toMatchObject({
      mode: 'form',
      message: 'Deploy web 2.0.0 to production?',
      requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] },
    });
    expect(store.getEnvironments().production.web).toBe('1.3.0');
  });
});

describe('answerApproval', () => {
  it('accepting approval completes the deploy and sets the production version', async () => {
    const task = startDeploy(store, production, { stepDelayMs: 0 });
    await reach(task.taskId, 'input_required');
    answerApproval(store, task.taskId, accept);
    await reach(task.taskId, 'completed');
    expect(store.getEnvironments().production.web).toBe('2.0.0');
    expect(store.getTask(task.taskId)?.inputRequests).toBeUndefined();
  });

  it.each([
    ['decline', { approve: { action: 'decline' } }],
    ['cancel', { approve: { action: 'cancel' } }],
    ['approve:false', { approve: { action: 'accept', content: { approve: false } } }],
  ])('%s ends the deploy cancelled and leaves the version unchanged', async (_name, answer) => {
    const task = startDeploy(store, production, { stepDelayMs: 0 });
    await reach(task.taskId, 'input_required');
    answerApproval(store, task.taskId, answer);
    await reach(task.taskId, 'cancelled');
    expect(store.getTask(task.taskId)?.statusMessage).toBe('Approval declined');
    expect(store.getEnvironments().production.web).toBe('1.3.0');
  });

  it('a malformed answer, an answer for another key, and a second answer are all ignored', async () => {
    const task = startDeploy(store, production, { stepDelayMs: 0 });
    await reach(task.taskId, 'input_required');
    for (const bad of [undefined, null, 'yes', {}, { approve: 'yes' }, { approve: { action: 'accept' } }, { approve: { action: 'accept', content: { approve: 'true' } } }, { other: { action: 'accept', content: { approve: true } } }]) {
      answerApproval(store, task.taskId, bad);
      expect(status(task.taskId)).toBe('input_required');
    }
    answerApproval(store, task.taskId, accept);
    await reach(task.taskId, 'completed');
    answerApproval(store, task.taskId, { approve: { action: 'decline' } });
    expect(status(task.taskId)).toBe('completed');
    expect(store.getEnvironments().production.web).toBe('2.0.0');
  });

  it('an answer for an unknown task is ignored', () => {
    expect(() => answerApproval(store, 'nope', accept)).not.toThrow();
  });
});

describe('cancelDeploy', () => {
  it('cancels a working deploy and the version stays unchanged', async () => {
    const task = startDeploy(store, staging, { stepDelayMs: 40 });
    cancelDeploy(store, task.taskId);
    expect(status(task.taskId)).toBe('cancelled');
    await new Promise((r) => setTimeout(r, 250));
    expect(status(task.taskId)).toBe('cancelled');
    expect(store.getEnvironments().staging.web).toBe('1.3.2');
  });

  it('cancels a deploy that is waiting for approval', async () => {
    const task = startDeploy(store, production, { stepDelayMs: 0 });
    await reach(task.taskId, 'input_required');
    cancelDeploy(store, task.taskId);
    await reach(task.taskId, 'cancelled');
    expect(store.getEnvironments().production.web).toBe('1.3.0');
  });

  it('is acknowledged and changes nothing on a finished task', async () => {
    const task = startDeploy(store, staging, { stepDelayMs: 0 });
    await reach(task.taskId, 'completed');
    cancelDeploy(store, task.taskId);
    expect(status(task.taskId)).toBe('completed');
  });
});

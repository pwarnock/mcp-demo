import { z } from 'zod';
import type { EnvironmentName } from './environments.js';
import type { StateStore, TaskRecord } from './store.js';

export interface DeployRequest {
  service: string;
  version: string;
  environment: EnvironmentName;
}

const STEPS = ['validate', 'build', 'migrate', 'rollout'] as const;

/** Deploys waiting for a human answer, by task id. Resolving one resumes (true) or ends (false) its deploy. */
const approvalWaiters = new Map<string, (approved: boolean) => void>();

const ApprovalAnswer = z.object({
  approve: z.union([
    z.object({ action: z.literal('accept'), content: z.object({ approve: z.boolean() }) }),
    z.object({ action: z.enum(['decline', 'cancel']) }),
  ]),
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isActive = (store: StateStore, taskId: string): boolean => {
  const status = store.getTask(taskId)?.status;
  return status === 'working' || status === 'input_required';
};

/** Creates the task (throws TooManyTasksError at the cap), then runs the simulated deploy in the background. */
export function startDeploy(store: StateStore, req: DeployRequest, opts: { stepDelayMs: number }): TaskRecord {
  const task = store.createTask({ statusMessage: `Step 1 of ${STEPS.length}: ${STEPS[0]}` });
  void run(store, task.taskId, req, opts.stepDelayMs).catch((err: unknown) => {
    console.error('[deploy] unexpected failure', err instanceof Error ? err.message : 'unknown error');
    store.updateTask(task.taskId, { status: 'failed', error: { code: -32603, message: 'Deployment failed' } });
  });
  return task;
}

async function run(store: StateStore, taskId: string, req: DeployRequest, stepDelayMs: number): Promise<void> {
  for (const [index, name] of STEPS.entries()) {
    if (!isActive(store, taskId)) return;
    if (name === 'rollout' && req.environment === 'production' && !(await awaitApproval(store, taskId, req))) {
      store.updateTask(taskId, { status: 'cancelled', statusMessage: 'Approval declined', inputRequests: undefined });
      return;
    }
    if (!isActive(store, taskId)) return;
    store.updateTask(taskId, { status: 'working', statusMessage: `Step ${index + 1} of ${STEPS.length}: ${name}`, inputRequests: undefined });
    await sleep(stepDelayMs);
  }
  if (!isActive(store, taskId)) return;
  store.setVersion(req.environment, req.service, req.version);
  store.updateTask(taskId, {
    status: 'completed',
    statusMessage: 'Deployment complete',
    result: { content: [{ type: 'text', text: `Deployed ${req.service} ${req.version} to ${req.environment}` }] },
  });
}

function awaitApproval(store: StateStore, taskId: string, req: DeployRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    approvalWaiters.set(taskId, resolve);
    store.updateTask(taskId, {
      status: 'input_required',
      statusMessage: 'Waiting for approval',
      inputRequests: {
        approve: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: `Deploy ${req.service} ${req.version} to production?`,
            requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] },
          },
        },
      },
    });
  });
}

/** Applies a client's answer to the outstanding approval request. Anything else is ignored. */
export function answerApproval(store: StateStore, taskId: string, inputResponses: unknown): void {
  const waiter = approvalWaiters.get(taskId);
  if (waiter === undefined || store.getTask(taskId)?.status !== 'input_required') return;
  const parsed = ApprovalAnswer.safeParse(inputResponses);
  if (!parsed.success) return;
  const answer = parsed.data.approve;
  approvalWaiters.delete(taskId);
  waiter(answer.action === 'accept' && answer.content.approve);
}

/** Ends a deploy that has not finished. A finished task is left as it is. */
export function cancelDeploy(store: StateStore, taskId: string): void {
  if (!isActive(store, taskId)) return;
  store.updateTask(taskId, { status: 'cancelled', statusMessage: 'Cancelled by client', inputRequests: undefined });
  const waiter = approvalWaiters.get(taskId);
  if (waiter !== undefined) {
    approvalWaiters.delete(taskId);
    waiter(false);
  }
}

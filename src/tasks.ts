import { type McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { declaredCapabilities } from './capabilities.js';
import type { StateStore, TaskRecord } from './store.js';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const MAX_INPUT_KEYS = 16;

type TaskFields = Pick<TaskRecord, 'taskId' | 'status' | 'statusMessage' | 'createdAt' | 'lastUpdatedAt' | 'ttlMs' | 'pollIntervalMs'>;

const taskFields = (t: TaskRecord): TaskFields => ({
  taskId: t.taskId,
  status: t.status,
  ...(t.statusMessage === undefined ? {} : { statusMessage: t.statusMessage }),
  createdAt: t.createdAt,
  lastUpdatedAt: t.lastUpdatedAt,
  ttlMs: t.ttlMs,
  pollIntervalMs: t.pollIntervalMs,
});

/** The `tools/call` result that hands the client a task. */
export function toCreateTaskResult(t: TaskRecord): Record<string, unknown> {
  return { resultType: 'task', ...taskFields(t) };
}

/** The `tasks/get` result: task fields plus `result`, `error` or `inputRequests` for the matching status only. */
export function toGetTaskResult(t: TaskRecord): Record<string, unknown> {
  return {
    resultType: 'complete',
    ...taskFields(t),
    ...(t.status === 'completed' && t.result !== undefined ? { result: t.result } : {}),
    ...(t.status === 'failed' && t.error !== undefined ? { error: t.error } : {}),
    ...(t.status === 'input_required' && t.inputRequests !== undefined ? { inputRequests: t.inputRequests } : {}),
  };
}

/** True when this request declared the tasks extension. Never return a task to a client that did not. */
export function clientSupportsTasks(ctx: { mcpReq: { envelope?: object } }): boolean {
  const extensions = declaredCapabilities(ctx).extensions;
  return typeof extensions === 'object' && extensions !== null && Object.hasOwn(extensions, TASKS_EXTENSION);
}

const TaskId = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/);
const GetParams = z.object({ taskId: TaskId }).passthrough();
const AnyResult = z.object({}).passthrough();

/** Runs a handler body; anything but a protocol error is logged and replaced by a generic -32603. */
function guarded<T>(method: string, body: () => T): T {
  try {
    return body();
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    console.error(`[${method}] failed:`, err instanceof Error ? err.message : 'unknown error');
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'Internal error');
  }
}

/** Advertises the extension and serves `tasks/get`, `tasks/update` and `tasks/cancel` on the SDK's custom-handler path. */
export function registerTasksExtension(
  mcp: McpServer,
  store: StateStore,
  deps: { onUpdate: (task: TaskRecord, inputResponses: unknown) => void; onCancel: (task: TaskRecord) => void },
): void {
  mcp.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } } as never);
  const find = (taskId: string): TaskRecord => {
    const task = store.getTask(taskId);
    if (task === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task');
    return task;
  };
  mcp.server.setRequestHandler('tasks/get', { params: GetParams, result: AnyResult }, async ({ taskId }) => guarded('tasks/get', () => toGetTaskResult(find(taskId))));
  // The SDK lifts `inputResponses` out of the params into ctx.mcpReq.inputResponses (untrusted client data).
  mcp.server.setRequestHandler('tasks/update', { params: GetParams, result: AnyResult }, async ({ taskId }, ctx) => {
    const inputResponses = ctx.mcpReq.inputResponses;
    if (inputResponses !== undefined && Object.keys(inputResponses).length > MAX_INPUT_KEYS) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Too many inputResponses');
    }
    guarded('tasks/update', () => deps.onUpdate(find(taskId), inputResponses));
    return {};
  });
  mcp.server.setRequestHandler('tasks/cancel', { params: GetParams, result: AnyResult }, async ({ taskId }) => {
    guarded('tasks/cancel', () => deps.onCancel(find(taskId)));
    return {};
  });
}

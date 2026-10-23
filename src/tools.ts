import { type McpServer, type RequestStateCodec, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { startDeploy } from './deploy.js';
import { SERVICE_PATTERN, VERSION_PATTERN } from './environments.js';
import { type StateStore, TooManyTasksError } from './store.js';
import { clientSupportsTasks, toCreateTaskResult } from './tasks.js';

export interface ServerDeps {
  store: StateStore;
  stepDelayMs: number;
  /** HMAC key (at least 32 bytes) that seals `requestState` for multi-round-trip tools. */
  requestStateKey: Uint8Array;
}

export interface RollbackState {
  service: string;
  environment: string;
  toVersion: string;
}

const environment = z.enum(['dev', 'staging', 'production']);
const service = z.string().regex(SERVICE_PATTERN);
const version = z.string().max(32).regex(VERSION_PATTERN);

const ListInput = z.strictObject({});
const DeployInput = z.strictObject({ service, version, environment });
const RollbackInput = z.strictObject({ service, environment, toVersion: version });
type DeployArgs = z.infer<typeof DeployInput>;
type RollbackArgs = z.infer<typeof RollbackInput>;

const ConfirmSchema = z.object({ confirm: z.boolean().describe('Set to true to roll back.') });
const ConfirmAnswer = z.union([
  z.object({ action: z.literal('accept'), content: z.object({ confirm: z.boolean() }) }),
  z.object({ action: z.enum(['decline', 'cancel']) }),
]);

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (t: string) => ({ isError: true as const, ...text(t) });

const knowsService = (store: StateStore, env: string, name: string): boolean => {
  const services = store.getEnvironments()[env as keyof ReturnType<StateStore['getEnvironments']>];
  return services !== undefined && Object.hasOwn(services, name);
};

/** `deploy_release`: returns a task to a tasks-capable client, an error result otherwise. */
export function deployRelease(deps: ServerDeps, args: DeployArgs, ctx: Parameters<typeof clientSupportsTasks>[0]): Record<string, unknown> {
  if (!knowsService(deps.store, args.environment, args.service)) return fail(`Unknown service: ${args.service}`);
  if (!clientSupportsTasks(ctx)) return fail('deploy_release needs a client that supports the MCP tasks extension.');
  try {
    return toCreateTaskResult(startDeploy(deps.store, args, { stepDelayMs: deps.stepDelayMs }));
  } catch (err) {
    if (err instanceof TooManyTasksError) return fail('Too many deploys are running. Try again when one finishes.');
    console.error('[deploy_release] failed to start', err instanceof Error ? err.message : 'unknown error');
    return fail('Could not start the deploy.');
  }
}

export function registerTools(mcp: McpServer, deps: ServerDeps, codec: RequestStateCodec<RollbackState>): void {
  mcp.registerTool(
    'list_environments',
    {
      description: 'List which version of each service runs in dev, staging and production.',
      inputSchema: ListInput,
      annotations: { readOnlyHint: true },
    },
    async () => text(JSON.stringify(deps.store.getEnvironments())),
  );

  mcp.registerTool(
    'deploy_release',
    {
      description:
        'Deploy a service version to an environment. Returns a task to poll. A production deploy pauses and asks the user to approve before the rollout step.',
      inputSchema: DeployInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, ctx) => deployRelease(deps, args, ctx) as never,
  );

  mcp.registerTool(
    'rollback_release',
    {
      description: 'Roll a service in an environment back to an earlier version. Asks the user to confirm first; nothing changes until they do.',
      inputSchema: RollbackInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args: RollbackArgs, ctx) => {
      if (!knowsService(deps.store, args.environment, args.service)) return fail(`Unknown service: ${args.service}`);
      const state = ctx.mcpReq.requestState<RollbackState>();
      const bound = state?.service === args.service && state.environment === args.environment && state.toVersion === args.toVersion;
      const answer = bound ? ConfirmAnswer.safeParse(ctx.mcpReq.inputResponses?.confirm) : undefined;
      if (answer?.success) {
        const reply = answer.data;
        if (reply.action === 'accept' && reply.content.confirm) {
          deps.store.setVersion(args.environment, args.service, args.toVersion);
          return text(`Rolled back ${args.service} in ${args.environment} to ${args.toVersion}`);
        }
        return text('Rollback cancelled. Nothing was changed.');
      }
      return inputRequired({
        requestState: await codec.mint({ service: args.service, environment: args.environment, toVersion: args.toVersion }),
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Roll back ${args.service} in ${args.environment} to ${args.toVersion}?`,
            requestedSchema: ConfirmSchema,
          }),
        },
      });
    },
  );
}

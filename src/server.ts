import { McpServer, createRequestStateCodec } from '@modelcontextprotocol/server';
import { answerApproval, cancelDeploy } from './deploy.js';
import { type RollbackState, type ServerDeps, registerTools } from './tools.js';
import { registerTasksExtension } from './tasks.js';

export type { ServerDeps } from './tools.js';

/** Builds one release-manager server. `serveStdio` calls this per connection; state lives in `deps.store`. */
export function createServer(deps: ServerDeps): McpServer {
  const codec = createRequestStateCodec<RollbackState>({ key: deps.requestStateKey });
  const mcp = new McpServer(
    { name: 'release-manager', version: '0.1.0' },
    { capabilities: { tools: {} }, requestState: { verify: codec.verify } },
  );
  registerTasksExtension(mcp, deps.store, {
    onUpdate: (task, inputResponses) => answerApproval(deps.store, task.taskId, inputResponses),
    onCancel: (task) => cancelDeploy(deps.store, task.taskId),
  });
  registerTools(mcp, deps, codec);
  return mcp;
}

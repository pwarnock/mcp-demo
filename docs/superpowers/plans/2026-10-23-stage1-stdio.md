# Stage 1 (stdio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stdio MCP server, a pretend release manager, that serves MCP tasks and elicitation to Claude Code on protocol revision 2026-07-28.

**Architecture:** One server factory (`createServer`) served by the SDK's `serveStdio`. Task state and environment versions live in one file-backed `StateStore`. The SDK has no tasks runtime, so the tasks extension is implemented here, on the SDK's custom-request-handler path, and Task 2 proves that is possible before anything else is built.

**Tech Stack:** TypeScript, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0, Zod v4, Vitest, bun for packages and scripts, Node 22+ LTS as the runtime.

**Spec:** `docs/superpowers/specs/2026-10-23-ts-mcp-demo-design.md`. Read it first; this plan does not repeat its reasoning.

## Global Constraints

- Protocol revision `2026-07-28`; Claude Code 2.1.304 or later (2.1.309 is installed locally).
- Packages: `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0`, `zod@4`; dev: `typescript`, `vitest`, `@types/node`. The v1 `@modelcontextprotocol/sdk` is not used.
- Nothing but protocol messages on stdout. All logging goes to stderr, and never includes secrets or `requestState`.
- Task wire contract (from the Claude Code docs): `tools/call` answers with `resultType: "task"` and `taskId` (at most 128 printable ASCII characters, no spaces), `status` (`working` | `input_required` | `completed` | `failed` | `cancelled`), `createdAt`, `lastUpdatedAt`, `ttlMs` (number or `null`), optional `pollIntervalMs` (250 to 30000) and `statusMessage`. `tasks/get` answers with `resultType: "complete"` plus the same fields, `result` on `completed`, `error` `{ code, message, data? }` on `failed`, and `inputRequests` (at most 16 keys) on `input_required`. `tasks/update` takes `{ taskId, inputResponses }`; `tasks/cancel` takes `{ taskId }`. An unknown `taskId` is JSON-RPC error `-32602`. A task is returned only when the request's `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` contains `"io.modelcontextprotocol/tasks"`.
- Tool names `list_environments`, `deploy_release`, `rollback_release`; environments `dev`, `staging`, `production`.
- Git: work on a feature branch, never push to `main`, commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, open a PR after the first push. American spelling in all text.
- Every test that claims to pin a security rule must be shown failing (a mutation check) when the rule is removed. Revert the mutation before committing.

## Review Focus

Inputs and conditions the spec implies but that no happy-path task exercises, most likely first. Each has a pinning test in the task named in brackets.

1. A client that did not declare the tasks extension calls `deploy_release`: it must get a plain error result saying a tasks-capable client is required, never a task object. [Task 6]
2. `tasks/get`, `tasks/update` or `tasks/cancel` with an unknown or malformed `taskId`: JSON-RPC `-32602`, no crash, no leaked internals. [Task 5]
3. `tasks/update` for a key that is not outstanding or was already answered, or with a malformed response: ignored with an empty result; the task is unchanged. [Task 5]
4. A tampered, truncated or replayed `requestState` on the `rollback_release` retry: refused with `-32602` "Invalid or expired requestState"; no rollback happens. [Task 6]
5. Approval declined, cancelled, or `approve: false`: the production deploy ends `cancelled` and the environment version is unchanged. [Task 5]

## File Structure

| File | Responsibility |
| - | - |
| `package.json`, `tsconfig.json`, `.gitignore` | Project config (Task 1) |
| `src/environments.ts` | Seed data, `Environment` type, input patterns (Task 3) |
| `src/store.ts` | `StateStore`: file-backed environments and tasks, atomic writes, recovery (Task 4) |
| `src/tasks.ts` | Wire mapping and the extension handlers (Task 5) |
| `src/deploy.ts` | `runDeploy`: the simulated deploy state machine (Task 5) |
| `src/tools.ts` | Tool registration, schemas, annotations (Task 6) |
| `src/server.ts` | `createServer(deps)` (Task 6) |
| `src/main.ts` | stdio entrypoint (Task 7) |
| `src/*.test.ts` | Unit tests beside the code; `tests/stdio.e2e.test.ts` for the spawned-process test |
| `docs/superpowers/spikes/2026-10-23-tasks-spike.md` | Task 2 findings |
| `README.md` | Rewritten in Task 8 |

---

### Task 1: Scaffold the TypeScript project

**Files:**
- Delete: `copilot_mcp_example.py`, `cursor_integration_demo.py`, `cursor_integration_report.md`, `requirements.txt`
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/smoke.test.ts`

**Interfaces:**
- Produces: scripts `bun run typecheck` (`tsc --noEmit`), `bun run test` (`vitest run`), `bun run start` (`bun src/main.ts`, used from Task 7).

- [ ] **Step 1:** Create the branch from `main` (after PR #2 merges; if it has not merged, from `docs/ts-demo-design`): `git switch -c feat/stage1-stdio`.
- [ ] **Step 2:** `git rm copilot_mcp_example.py cursor_integration_demo.py cursor_integration_report.md requirements.txt`. The old content stays reachable at tag `archive/2026-10-23-copilot-cursor-demo`.
- [ ] **Step 3:** Write `package.json` with `"type": "module"`, `"private": true`, `"engines": { "node": ">=22" }`, and the three scripts above. Run `bun add @modelcontextprotocol/server@2.4.0 @modelcontextprotocol/client@2.4.0 zod@4` then `bun add -d typescript vitest @types/node`.
- [ ] **Step 4:** Write `tsconfig.json` with `target` ES2023, `module` and `moduleResolution` NodeNext, `strict`, `noUncheckedIndexedAccess`, `skipLibCheck`, `noEmit`, `types: ["node"]`, `include: ["src", "tests"]`. Write `.gitignore` with `node_modules/`, `.state/`, `*.log`.
- [ ] **Step 5:** Write `src/smoke.test.ts`: test name `imports the SDK`, asserting `typeof McpServer === 'function'` for `McpServer` imported from `@modelcontextprotocol/server`.
- [ ] **Step 6:** Run `bun run typecheck && bun run test`. Expected: exit 0 and `1 passed`. (Verified on 2026-10-23 in a scratch project: TypeScript 7.0.2, Vitest 5.0.5.)
- [ ] **Step 7:** Commit `chore: replace Python demo with TypeScript scaffold`, then push the branch and open a PR.

**Done when:** the Python files are gone, typecheck and test pass, the PR exists. **Rollback:** `git reset --hard` is forbidden; instead `git revert` the commit.

---

### Task 2: Spike, and gate on serving the tasks extension

This task decides whether the rest of the plan is possible. Throwaway code goes in `spikes/tasks/` and is committed with the findings.

**Files:**
- Create: `spikes/tasks/server.ts`, `spikes/tasks/drive.ts`, `docs/superpowers/spikes/2026-10-23-tasks-spike.md`

**Interfaces:**
- Produces: a findings document answering questions A to D below, each with the evidence (command and output) and the exact working API call.

- [ ] **Step 1:** In `spikes/tasks/server.ts`, build an `McpServer` served by `serveStdio` (from `@modelcontextprotocol/server/stdio`, option `legacy: 'reject'`). Register a tool `slow` whose handler returns a hand-built `{ resultType: 'task', taskId: 't1', status: 'working', createdAt, lastUpdatedAt, ttlMs: null, pollIntervalMs: 500 }` when the request's client capabilities include the tasks extension, and a normal text result otherwise. Register `tasks/get`, `tasks/update` and `tasks/cancel` with `setRequestHandler(method, { params, result }, handler)` on the underlying server (`server.server`), and advertise `extensions: { 'io.modelcontextprotocol/tasks': {} }` in the server capabilities.
- [ ] **Step 2:** In `spikes/tasks/drive.ts`, spawn the server with `StdioClientTransport` (from `@modelcontextprotocol/client/stdio`) and the SDK `Client`, call `slow` with the tasks extension declared, then `tasks/get`, `tasks/update`, `tasks/cancel`. If the SDK client cannot send those, spawn the server directly and write JSON-RPC lines to its stdin, copying the per-request `_meta` envelope shape from what the SDK client sends (log it on the server's stderr).
- [ ] **Step 3:** Answer in the findings document, with evidence:
  - **A.** Does a `tools/call` handler return `resultType: "task"` over the wire without an SDK validation error?
  - **B.** Do `tasks/get`, `tasks/update` and `tasks/cancel` reach the custom handlers and return their results over stdio?
  - **C.** Where does a handler read the request's declared client capabilities (`ctx.mcpReq.envelope`?), and does `server/discover` show the extension?
  - **D.** If A to C fail, does the third-party `mcp-durable-tasks` package (inspect `bun info mcp-durable-tasks` and its README first) do the job?
- [ ] **Step 4:** Commit `spike: tasks extension on SDK 2.4.0`.
- [ ] **Step 5 (gate):** If A, B and C are all yes, or D is yes, continue to Task 3 and record the working API calls in the findings. **If not, stop.** Do not make `deploy_release` synchronous. Report the findings to Peter and wait.

**Done when:** the findings document exists and the gate decision is recorded in its first line.

---

### Task 3: Environments and input patterns

**Files:**
- Create: `src/environments.ts`, `src/environments.test.ts`

**Interfaces:**
- Produces: `type EnvironmentName = 'dev' | 'staging' | 'production'`; `type Environments = Record<EnvironmentName, Record<string, string>>` (service name to version); `const SEED_ENVIRONMENTS: Environments` with services `web` and `api` at versions dev `1.4.0`, staging `1.3.2`, production `1.3.0`; `const SERVICE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/`; `const VERSION_PATTERN = /^\d+\.\d+\.\d+$/`.

- [ ] **Step 1:** Write `src/environments.test.ts`: `accepts web and api` and `rejects "../etc", "Web", "a", "web service", and 33-character names` against `SERVICE_PATTERN`; `accepts 1.4.0` and `rejects "1.4", "v1.4.0", "1.4.0-rc1", "1.4.0\n"` against `VERSION_PATTERN`.
- [ ] **Step 2:** Run `bun run test src/environments.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the exports above in `src/environments.ts`.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `bun run typecheck`.
- [ ] **Step 5:** Commit `feat: environment seed data and input patterns`.

---

### Task 4: File-backed state store

**Files:**
- Create: `src/store.ts`, `src/store.test.ts`

**Interfaces:**
- Consumes: `Environments`, `SEED_ENVIRONMENTS` (Task 3).
- Produces:
  - `type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'`
  - `interface TaskRecord { taskId: string; status: TaskStatus; statusMessage?: string; createdAt: string; lastUpdatedAt: string; ttlMs: number | null; pollIntervalMs: number; inputRequests?: Record<string, { method: 'elicitation/create'; params: unknown }>; result?: unknown; error?: { code: number; message: string; data?: unknown } }`
  - `class StateStore { constructor(opts: { path: string; maxActiveTasks: number }); getEnvironments(): Environments; setVersion(env: EnvironmentName, service: string, version: string): void; createTask(init: { statusMessage?: string }): TaskRecord; getTask(taskId: string): TaskRecord | undefined; updateTask(taskId: string, patch: Partial<Omit<TaskRecord, 'taskId' | 'createdAt'>>): TaskRecord; activeTaskCount(): number }`
  - `class TooManyTasksError extends Error`
  - `taskId` is `crypto.randomUUID()` (printable ASCII, no spaces, 36 characters). `pollIntervalMs` defaults to 1000 and `ttlMs` to 3600000 (one hour). A task in a terminal state whose `lastUpdatedAt` is older than its `ttlMs` is deleted when the store is opened and treated as unknown by `getTask`.
  - Writes go to a temporary file in the same directory, then `rename`. On construction, any task still `working` or `input_required` is rewritten to `failed` with error `{ code: -32603, message: 'Server restarted before the task finished' }`.

- [ ] **Step 1:** Write `src/store.test.ts` using a temp directory per test (`fs.mkdtemp`): `a new store starts from the seed environments`; `setVersion survives reopening the store`; `a task created in one store instance is found in a second instance on the same file`; `a working task becomes failed when the store is reopened`; `createTask throws TooManyTasksError at maxActiveTasks (set to 2), and succeeds again after one task completes`; `getTask returns undefined for an unknown id`; `a completed task older than its ttlMs is gone after reopening the store, and a younger one is kept` (use a store option or fake clock to control time); `a corrupt state file throws an error that does not include the file contents`.
- [ ] **Step 2:** Run `bun run test src/store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `StateStore`. Synchronous `node:fs` calls are fine; the server is single-process.
- [ ] **Step 4:** Run the test. Expected: PASS. Mutation check: make `createTask` ignore `maxActiveTasks`; expect `createTask throws TooManyTasksError…` to fail; revert.
- [ ] **Step 5:** Commit `feat: file-backed state store with restart recovery`.

---

### Task 5: Deploy state machine and the tasks extension

**Files:**
- Create: `src/deploy.ts`, `src/tasks.ts`, `src/deploy.test.ts`, `src/tasks.test.ts`

**Interfaces:**
- Consumes: `StateStore`, `TaskRecord` (Task 4); the working API calls recorded in the Task 2 findings for custom handlers and reading client capabilities.
- Produces:
  - `deploy.ts`: `interface DeployRequest { service: string; version: string; environment: EnvironmentName }`; `function startDeploy(store: StateStore, req: DeployRequest, opts: { stepDelayMs: number }): TaskRecord`. It creates the task, then advances it in the background through the steps `validate`, `build`, `migrate`, `rollout`, writing `statusMessage` such as `Step 2 of 4: build`. For `production`, before `rollout` it sets `status: 'input_required'` with `inputRequests.approve` = `{ method: 'elicitation/create', params: { mode: 'form', message: 'Deploy <service> <version> to production?', requestedSchema: { type: 'object', properties: { approve: { type: 'boolean' } }, required: ['approve'] } } }` and waits. `function answerApproval(store: StateStore, taskId: string, inputResponses: unknown): void` accepts only a response for key `approve` while the task is `input_required`; `{ action: 'accept', content: { approve: true } }` resumes the rollout; every other well-formed answer (`decline`, `cancel`, `approve: false`) ends the task `cancelled` with `statusMessage: 'Approval declined'`; anything malformed is ignored. On `completed`, the environment version is set and `result` is a text `CallToolResult` naming the service, version and environment.
  - `tasks.ts`: `function toCreateTaskResult(t: TaskRecord): object` (adds `resultType: 'task'`); `function toGetTaskResult(t: TaskRecord): object` (adds `resultType: 'complete'`, includes `result`, `error`, `inputRequests` only when set); `function registerTasksExtension(server: McpServer, store: StateStore, deps: { onUpdate: (t: TaskRecord, inputResponses: unknown) => void; onCancel: (t: TaskRecord) => void }): void`, which advertises the extension and serves `tasks/get`, `tasks/update` and `tasks/cancel`; `function clientSupportsTasks(ctx): boolean`. Exact types for `ctx` and the handler registration come from the Task 2 findings. `tasks/update` and `tasks/cancel` answer with an empty result `{}`. An unknown, empty or over-128-character `taskId` throws a protocol error with code `-32602`.

- [ ] **Step 1:** Write `src/deploy.test.ts` (fake timers, `stepDelayMs: 0`, temp-dir store): `a staging deploy goes working then completed and sets the version`; `a production deploy stops at input_required with an approve request`; `accepting approval completes the deploy and sets the production version`; `decline, cancel and approve:false each end cancelled and leave the version unchanged` (use `it.each`); `a malformed answer, an answer for another key, and a second answer are all ignored`; `statusMessage names the current step`.
- [ ] **Step 2:** Write `src/tasks.test.ts` against `toCreateTaskResult` and `toGetTaskResult`: field sets match the Global Constraints wire contract exactly (assert on `Object.keys`), `resultType` values, `result` present only when `completed`, `error` only when `failed`, `inputRequests` only when `input_required`, and the handler tests from the Task 2 working approach for `unknown taskId yields -32602`, `an empty taskId yields -32602`, `update for an unknown key leaves the task unchanged`, `cancel on a terminal task is acknowledged and the status does not change`.
- [ ] **Step 3:** Run `bun run test src/deploy.test.ts src/tasks.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement `deploy.ts`, then `tasks.ts`.
- [ ] **Step 5:** Run the tests. Expected: PASS. Mutation checks, each reverted afterward: make `answerApproval` resume on any answer (expect the decline/cancel test to fail); make the handler return `{}` for an unknown id (expect the `-32602` test to fail).
- [ ] **Step 6:** Commit `feat: deploy state machine and tasks extension`.

---

### Task 6: Tools and server factory

**Files:**
- Create: `src/tools.ts`, `src/server.ts`, `src/tools.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `interface ServerDeps { store: StateStore; stepDelayMs: number; requestStateKey: Uint8Array }`; `function createServer(deps: ServerDeps): McpServer`, passing `requestState: { verify }` from `createRequestStateCodec({ key: requestStateKey })` (HMAC; the SDK's options also set how long minted state stays valid) in the server options, and using the same codec's `mint` for the `rollback_release` state.
- Tool schemas (Zod v4, all `.strict()`): `list_environments` takes `{}`, annotations `readOnlyHint: true`; `deploy_release` takes `{ service: string matching SERVICE_PATTERN, version: string matching VERSION_PATTERN limited to 32 characters, environment: enum }`, annotations `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`; `rollback_release` takes `{ service, environment, toVersion }` with the same patterns, annotations `destructiveHint: true`.
- `deploy_release`: if `clientSupportsTasks` is false, return `{ isError: true, content: [{ type: 'text', text: 'deploy_release needs a client that supports the MCP tasks extension.' }] }`; if `StateStore.createTask` throws `TooManyTasksError`, return an `isError` result saying too many deploys are running; otherwise return `toCreateTaskResult(startDeploy(...))`.
- `rollback_release`: unless `acceptedContent(ctx.mcpReq.inputResponses, 'confirm', schema)` reports `{ confirm: true }`, return `inputRequired({ requestState: <minted>, inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) } })`, where the minted state binds the service, environment and target version; on the retry, refuse unless the verified state matches the arguments. On confirmation, set the version and return a text result.

- [ ] **Step 1:** Write `src/tools.test.ts` using the SDK's `InMemoryTransport` (verified to exist in both packages) and a `Client`: `tools/list shows three tools with the declared annotations`; `list_environments returns the seed versions`; `deploy_release rejects unknown fields, a bad service, a bad version, a 33-character version, and an unknown environment`; `a client without the tasks extension gets an isError result and no task is created` (Review Focus 1); `rollback_release asks for confirmation and changes nothing on the first call`; `rollback_release acts only after an accepted confirmation`; `a declined or cancelled confirmation changes nothing`; `a tampered requestState is refused with -32602 and nothing changes` (Review Focus 4); `a requestState minted for one service cannot confirm a rollback of another`.
- [ ] **Step 2:** Run `bun run test src/tools.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `tools.ts` and `server.ts`. Handlers log failures to stderr and return generic messages to the client.
- [ ] **Step 4:** Run the tests. Expected: PASS. Mutation checks, each reverted: remove the `requestState` option from `createServer` (expect the tampering test to fail); drop `.strict()` from `deploy_release` (expect the unknown-field test to fail).
- [ ] **Step 5:** Commit `feat: release-manager tools and server factory`.

---

### Task 7: stdio entrypoint and end-to-end test

**Files:**
- Create: `src/main.ts`, `tests/stdio.e2e.test.ts`

**Interfaces:**
- Produces: `src/main.ts` reads `STATE_PATH` (default `.state/state.json`), `REQUEST_STATE_KEY` (hex, 32 bytes; if absent, generates a random key and logs once to stderr that rollback confirmations will not survive a restart), builds `createServer` and calls `serveStdio(factory, { legacy: 'reject', onerror })` with `onerror` writing to stderr.

- [ ] **Step 1:** Write `tests/stdio.e2e.test.ts`: spawn `bun src/main.ts` with a temp `STATE_PATH` and `STEP_DELAY_MS=0`; `every stdout line is valid JSON-RPC` (collect stdout while running a full staging deploy, assert each line parses and has `jsonrpc: "2.0"`); `a staging deploy reaches completed over stdio`; `a production deploy reaches input_required, then completes after tasks/update`; `a task is still answerable after the server process is restarted on the same state file` (completed task) and `an unfinished task reports failed after restart`.
- [ ] **Step 2:** Run `bun run test tests/stdio.e2e.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/main.ts`; add `STEP_DELAY_MS` (default 1500) as a documented test knob.
- [ ] **Step 4:** Run the whole suite and typecheck: `bun run typecheck && bun run test`. Expected: all pass.
- [ ] **Step 5:** Mutation check: add a `console.log('hello')` to `src/main.ts`, expect `every stdout line is valid JSON-RPC` to fail; revert.
- [ ] **Step 6:** Commit `feat: stdio entrypoint and end-to-end tests`.

---

### Task 8: README and manual Claude Code run

**Files:**
- Modify: `README.md` (rewrite)
- Create: `docs/superpowers/spikes/2026-10-23-stage1-claude-code-run.md`

- [ ] **Step 1:** Rewrite `README.md`: what the demo is, how to run the tests, how to add it with `claude mcp add release-manager -- bun <path-to-repo>/src/main.ts` (form checked against `claude mcp add --help` on 2026-10-23; use the placeholder, never a real local path), what each tool demonstrates, the security practices applied (one line each, naming the file), and the limits: interactive sessions only, no tasks in `claude -p`, the VS Code extension or the desktop app.
- [ ] **Step 2:** Ask Peter to run, in an interactive Claude Code 2.1.304+ session, the checklist below, and record each result in `docs/superpowers/spikes/2026-10-23-stage1-claude-code-run.md`: (a) `list_environments` works; (b) a staging `deploy_release` appears in `/tasks` and completes; (c) a production `deploy_release` pauses and the approval dialog appears (close `/tasks` to answer); (d) declining ends the task cancelled; (e) `rollback_release` shows a confirmation and acts only after accepting; (f) restart Claude Code mid-task and see what `/tasks` reports.
- [ ] **Step 3:** For any result that differs from the design, follow the design's rule: adapt the server where the spec allows, otherwise record the gap in the README. If (c) or (e) cannot be demonstrated at all, stop and report.
- [ ] **Step 4:** Commit `docs: README and Claude Code run results`, push, and update the PR description.

**Done when:** the full suite passes, the manual checklist is recorded, the PR is updated, and nothing is merged without Peter.

## Self-review notes

- Spec coverage: tasks (Tasks 2, 4, 5), elicitation inside a task (Task 5) and outside one (Task 6), security practices (schemas and annotations in Task 6, stderr-only logging in Task 7, bounded tasks in Task 4, `requestState` integrity in Task 6), durability (Tasks 4 and 7), Claude Code acceptance (Task 8). Stage 2 is intentionally absent.
- A decision of mine, not in the spec: a client without the tasks extension gets an error result from `deploy_release` rather than a synchronous run.

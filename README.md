# MCP release-manager demo (TypeScript)

A small MCP server, a pretend release manager, for learning three features of the 2026-07-28 MCP revision with the current TypeScript SDK (`@modelcontextprotocol/server` 2.4.0):

- **MCP Tasks**: `deploy_release` returns a task handle immediately instead of blocking.
- **Elicitation**: a production deploy pauses and asks you to approve; `rollback_release` asks you to confirm.
- **Secure server basics**: input validation, honest tool annotations, bounded resources, signed multi-round-trip state, stdout kept clean.

This is **stage 1: stdio**. Stage 2 (Streamable HTTP with OAuth, interactive vs autonomous clients) is designed in `docs/superpowers/specs/2026-10-23-ts-mcp-demo-design.md` and not built yet. The earlier Python demo is archived at tag `archive/2026-10-23-copilot-cursor-demo`.

## Requirements

- [Bun](https://bun.sh) and Node 22 or later.
- Claude Code 2.1.304 or later, in an **interactive** session. Tasks are not available in `claude -p`, the VS Code extension or the desktop app.

## Run the tests

```bash
bun install
bun run typecheck
bun run test
```

## Add it to Claude Code

```bash
claude mcp add release-manager -- bun <path-to-repo>/src/main.ts
```

Then start `claude` and try the steps below. This is what the design expects; in Claude Code, a deploy showing up in `/tasks`, a production deploy pausing at the approval dialog, and accepting or declining it have been confirmed; the rest is still being checked (see `docs/superpowers/spikes/2026-10-23-stage1-claude-code-run.md`), so treat each step as a check, not a promise:

1. "List the environments." (`list_environments`)
2. "Deploy web 2.0.0 to staging." The deploy shows up in `/tasks` and completes with no questions.
3. "Deploy web 2.0.0 to production." The task moves to `input_required`; close `/tasks` and answer the approval dialog. Decline it and the task ends `cancelled`.
4. "Roll web in production back to 1.2.0." A confirmation dialog appears; nothing changes until you accept.

## Tools

| Tool | What it does | Shows |
| - | - | - |
| `list_environments` | Read-only list of service versions per environment. | `readOnlyHint` |
| `deploy_release` | Returns a task, runs four simulated steps, pauses for approval before the production rollout. | Tasks, elicitation inside a task |
| `rollback_release` | Destructive. Returns an `input_required` result asking for confirmation, and acts only on the retried call. | Elicitation outside a task |

Services are `web` and `api`; environments are `dev`, `staging` and `production`. Nothing real is deployed. State (versions and tasks) is kept in a JSON file.

## Configuration

| Variable | Default | Meaning |
| - | - | - |
| `STATE_PATH` | `.state/state.json` next to this repo's `src/` | Where versions and tasks are stored. The default does not depend on the directory Claude Code was started in. |
| `REQUEST_STATE_KEY` | random per process | 64 hex characters. Seals the rollback confirmation state; set it if confirmations must survive a restart. |
| `STEP_DELAY_MS` | `1500` | Pause between simulated deploy steps (a test knob). |

## Security practices, and where to read them

| Practice | Where |
| - | - |
| Every tool input is a strict Zod schema with patterns and length limits; unknown fields are rejected. | `src/tools.ts`, `src/environments.ts` |
| Tools carry honest `readOnlyHint` / `destructiveHint` annotations. | `src/tools.ts` |
| Production deploys and rollbacks need a human answer before anything changes. | `src/deploy.ts`, `src/tools.ts` |
| Multi-round-trip `requestState` is HMAC-sealed; tampered, truncated or foreign-key state is refused with `-32602`. State minted for different arguments cannot confirm a rollback (it asks again). A valid state for the same arguments can be replayed within its 10-minute lifetime; it carries no authority, the user's answer does. | `src/server.ts`, `src/tools.ts` |
| Client-supplied task ids never index a plain object (`__proto__` cannot resolve); versions are validated before they are written. | `src/store.ts` |
| A task is returned only to a client that declared the tasks extension. | `src/tasks.ts`, `src/tools.ts` |
| Running tasks are capped (8). Finished tasks are dropped about an hour after they finish, when the server next starts or the task is next polled. Tasks interrupted by a restart are reported `failed`, not left `working`. | `src/store.ts` |
| stdout carries protocol messages only; diagnostics go to stderr, and clients get generic error text instead of internal messages or file paths. | `src/main.ts`, `src/tools.ts`, `src/tasks.ts`, `tests/stdio.e2e.test.ts` |
| State file writes are atomic (temp file then rename) and private (mode 0600). | `src/store.ts` |

## Layout

`src/tasks.ts` implements the tasks extension on the SDK's custom-request-handler path, because SDK 2.4.0 has no tasks runtime. How that was established is in `docs/superpowers/spikes/2026-10-23-tasks-spike.md`. One known wrinkle: the SDK adds an empty `content` array to the task result that `tools/call` returns; see the Claude Code run notes.

## Known limits

- One server process per state file. Two Claude Code sessions share the default file, and the second to start marks the first one's running tasks `failed`; set a different `STATE_PATH` per session.
- Not a deployment system.
- No authentication: stdio servers take their credentials from the environment (see the design doc for why OAuth is stage 2).

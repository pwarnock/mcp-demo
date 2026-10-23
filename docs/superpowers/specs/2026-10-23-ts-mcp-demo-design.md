# TypeScript MCP demo: tasks, elicitation, and interactive vs autonomous auth

Date: 2026-10-23. Status: draft, awaiting approval.

## Intent

Peter wants a hands-on way to learn three things in the 2026-07-28 MCP spec revision, using the current TypeScript SDK and a server built the way a secure server should be built:

1. **MCP Tasks** (the tasks extension): a tool call that returns a durable handle instead of blocking.
2. **Elicitation**: the server asking the user for input mid-operation.
3. **Interactive vs autonomous authorization**: a user-present client (browser sign-in) next to a machine client acting on its own behalf.

The demo is a learning tool first and a reference second. Success means Peter can run it, watch each feature happen in Claude Code, and explain from the code why each security choice was made.

## Context

- The previous demo (a Python Copilot/Cursor integration) is archived at tag `archive/2026-10-23-copilot-cursor-demo` (commit `4b3c368`, pushed to `origin`).
- Claude Code installed locally is 2.1.309. Its docs say MCP tasks need v2.1.304 or later, on revision 2026-07-28, using the v2 SDK runtime.

## Goals

- A stdio MCP server that exercises tasks and elicitation end to end in Claude Code.
- A second stage: the same server over Streamable HTTP on `localhost`, protected by OAuth, with a local authorization server that needs no Docker.
- Both auth styles demonstrated against that server: authorization code + PKCE (user present) and `client_credentials` (no user).
- Security practices applied and, where practical, tested, each with a comment or README note saying which spec rule or risk it addresses.

## Non-goals

- Production deployment, hosting, or a real deployment system. The "deploy" is simulated.
- Rich UI (MCP apps), resources, prompts, sampling.
- Dynamic Client Registration and Client ID Metadata Documents (optional extras, see "My calls").
- Supporting hosts other than Claude Code. The docs say tasks are unavailable in the VS Code extension and desktop app.

## Anti-goals (a failure even if it technically works)

- A demo that only passes because it was never run in Claude Code.
- A hand-rolled token validator or hand-rolled OAuth server logic where a maintained library covers it. The MCP authorization tutorial says not to write token validation yourself.
- Security claims in comments that no test or run ever exercised.

## Scenario (accepted by Peter)

A pretend release manager. Tools:

| Tool | Behavior | Features shown |
| - | - | - |
| `list_environments` | Read-only. Lists environments and what version each runs. | Baseline tool, `readOnlyHint` |
| `deploy_release` | Returns a task immediately. Runs through a few simulated steps. For `production` it moves to `input_required` and asks a human to approve before the risky step. | Tasks, elicitation inside a task |
| `rollback_release` | Synchronous, destructive. Asks for confirmation through a form before acting. | Direct elicitation, `destructiveHint` |

The scenario is Peter's; the exact tool set above is my proposal.

## Stages

**Stage 1: stdio.** Tools above, no OAuth. Credentials, if any are needed, come from the environment (the spec says stdio servers should not follow the HTTP authorization spec).

**Stage 2: Streamable HTTP + OAuth.** Same tools, bound to `127.0.0.1`.

- Authorization server: `oidc-provider` 9.13.0 in the same repo, run as a Node process (`npm run auth`-style script). No Docker.
- Resource server: the demo MCP server, using the SDK's bearer-auth helpers if they fit (see Risks).
- Interactive client: Claude Code, with a pre-registered public client (`--client-id`, `--callback-port`).
- Autonomous client: a small script using the SDK client's `ClientCredentialsProvider`.
- Scopes: `mcp:read` for `list_environments`; `mcp:deploy` for `deploy_release` to non-production environments; `mcp:deploy:production` for `deploy_release` to `production` and for `rollback_release`. The required scope depends on the request arguments, which the spec allows ("the required scopes may be determined dynamically based on the specific request arguments"). A token lacking the needed scope gets `403` with `insufficient_scope` and the scope in the `WWW-Authenticate` challenge.
- Only the interactive client's registration may be granted `mcp:deploy:production`; the autonomous client's registration is limited to `mcp:read mcp:deploy`. So the autonomous client can run a staging deploy as a task that completes with no human input, and is refused on a production deploy and on rollback. Because elicitation needs a person, the production rules keep "approval requires a user" without the server having to guess whether a user is present.
- Where the two styles differ on a `403`: the spec says user-delegated clients should attempt step-up authorization, while `client_credentials` clients may abort. Claude Code does not step up on its own: its docs say to add the named scope to `oauth.scopes` and sign in again. The demo shows that manual step, and the autonomous script shows the abort.

## What was verified (and how)

- `oidc-provider` 9.13.0, run in a throwaway spike: `client_credentials` and authorization code + PKCE both return JWT access tokens with `aud` equal to the MCP server URL; an unknown resource is refused with `invalid_target`; discovery advertises S256 only; a public client without PKCE is rejected; the callback carries `iss` and discovery sets `authorization_response_iss_parameter_supported: true`. It requires explicit `RS256` signing config for JWT access tokens with its dev keys.
- Spec text and Claude Code docs, read on 2026-10-23: claims about tasks, `localhost` token endpoints, `--callback-port`, `--client-id`, and the stdio rule come from there.
- SDK 2.4.0 type declarations, read from the published package: `elicitInput` exists on the server; `ClientCredentialsProvider` exists on the client; `requireBearerAuth` and `mcpAuthMetadataRouter` exist in `@modelcontextprotocol/express` 2.0.2.

## Risks and unknowns (resolve with a spike before the plan)

1. **The SDK has no tasks runtime. This is the biggest risk.** The 2.4.0 typings say task methods are "2025-11-25 wire vocabulary with no SDK runtime": `tasks/get`, `tasks/update` and `tasks/cancel` are not on the typed method surface. The Claude Code tasks contract is a different, newer shape (`resultType: "task"`, `inputRequests`, `tasks/update`). The typings do mention an "era gate" that lets custom handlers register for the Tasks extension method names, so a hand-written implementation on the SDK's custom-handler path looks possible but is unproven. Options, in my order of preference: (a) implement the extension ourselves on the custom-handler path, which also teaches the most; (b) the third-party `mcp-durable-tasks` package (npm, 0.4.1, "server-side implementation of the MCP Tasks extension (SEP-2663)"), which I have not inspected. The spike must prove that a tool call can return `resultType: "task"` and that `tasks/get` / `tasks/update` / `tasks/cancel` can be served.
2. **Task durability under stdio.** A resumed Claude Code session starts a new server process, and the docs say a task ID must stay answerable across connections. An in-memory store would lose tasks. The task store needs to persist to disk (file or `node:sqlite`; planner's choice).
3. **Two elicitation paths.** Inside a task, input arrives through `inputRequests` and is answered with `tasks/update`. Outside a task (`rollback_release`), the server sends a normal elicitation request. I have not read the Claude Code docs section on responding to elicitation requests, so the exact behavior of the second path, and the capability check to use, is unverified.
4. **Non-interactive limits.** Per the docs, `claude -p` gets no tasks and cannot complete OAuth, and a task that needs input is cancelled in non-interactive sessions. The demo must be driven from an interactive session, and the README must say so.
5. **Claude Code against `oidc-provider`.** Untested. The expected path is a pre-registered client, `http://localhost:<port>/callback`, and a plain-`http` `localhost` token endpoint, which the docs say is allowed.
6. **The 2026-07-28 wire changes** (per-request client capabilities, `server/discover`) may change how the SDK's transports and the HTTP stage behave compared with the tutorial's 1.x code. The tutorial's TypeScript sample uses 1.x import paths and must not be copied.
7. `oidc-provider` logs "Unsupported runtime" on Node 26.12.0 (it targets Node 22 LTS). It worked in the spike.

## Security practices to apply

Stage 1 (stdio):

- Validate every tool input with a schema (Zod v4 via Standard Schema); reject unknown fields.
- Never write to stdout except protocol messages; log to stderr, and never log secrets.
- No shell, no filesystem access from tool arguments. The "deploy" has no real side effects.
- Annotate tools (`readOnlyHint`, `destructiveHint`) honestly.
- Require human confirmation (elicitation) before the production deploy step and before rollback.
- Bound resources: task TTL, maximum concurrent tasks, maximum input sizes.
- Return generic errors to the client; keep detail in stderr.

Stage 2 (HTTP + OAuth), from the MCP authorization spec and tutorial:

- Publish Protected Resource Metadata (RFC 9728). Answer unauthenticated requests with `401` and a `WWW-Authenticate` header carrying `resource_metadata` and `scope`.
- Validate every token: signature, issuer, expiry, and that the audience is this server (RFC 8707). Accept no other tokens and pass none through.
- Enforce scopes per tool; use `403 insufficient_scope` with the needed scope in one challenge.
- Use short-lived access tokens (the spike used 300 seconds).
- Never log `Authorization` headers, codes or tokens.
- Treat `Mcp-Session-Id`, if any, as untrusted input; do not tie authorization to it.
- Bind to `127.0.0.1` and check the `Origin` header on the HTTP endpoint (DNS-rebinding protection). This comes from my general knowledge of the transport spec, not from a page I read; confirm in the spec during planning.
- Use a maintained library for JWT verification instead of hand-written code.
- The demo authorization server is development-only: any username and password work, state is in memory. The README must say so.

## Decisions Peter made

- Archive the current repo revision first (done, as a tag).
- New demo in TypeScript on the latest SDK and the 2026-07-28 spec, with secure-server best practices.
- Start with stdio.
- Features to try: MCP tasks, elicitation, interactive vs autonomous auth.
- No Docker (it slows the machine).
- Authorization server: `oidc-provider`, verified first.
- Scenario: the release manager described above.

## My calls (change any of these)

- Archive as an annotated tag rather than a branch.
- The new demo replaces the Python files in this repo (the old content stays reachable through the tag). Work happens on feature branches with PRs; nothing is pushed to `main`.
- Server built on `@modelcontextprotocol/server` 2.x (not the v1 `@modelcontextprotocol/sdk`), with `@modelcontextprotocol/express` for the HTTP stage if it fits.
- Package manager `bun` per the global toolchain preference; runtime Node 22+ LTS; test runner Vitest. Confirm against the toolchain rules when planning.
- Claude Code uses a pre-registered public client, not DCR or CIMD.
- The autonomous client is a script, not Claude Code, because Claude Code only runs the interactive flow.
- Scope names `mcp:read` and `mcp:deploy`, and the three tool names.
- Delivery is two plans and two PRs: stage 1 (stdio) first, including the Risk 1 and Risk 3 spikes; stage 2 is planned only after stage 1 ships, with its own spike for Risks 5 and 6.
- **Gate on tasks:** if the Risk 1 spike shows neither option can serve the Tasks extension, stop and bring that back to Peter. Do not quietly make `deploy_release` synchronous. Tasks are the first feature he asked about, so the project's shape is his call at that point.
- Acceptance means the behavior was observed in Claude Code and written down. If Claude Code behaves differently from the spec text, adapt the server where the spec allows it; otherwise record the gap in the README. If a feature cannot be demonstrated at all in Claude Code, stop and report.
- Repo contents today (checked): `README.md`, `requirements.txt`, `copilot_mcp_example.py`, `cursor_integration_demo.py`, `cursor_integration_report.md`. No CI config and no other docs. The first implementation step removes the Python files and `requirements.txt`; the README is rewritten, not deleted.

## Left to the builder

- Exact file layout, task store technology, step timings and messages in the simulated deploy.
- How to structure the spike for Risk 1 and what to do if it fails (fall back to option (b), or report that the SDK cannot serve the extension).
- Test design. Any test that claims to pin a security rule must be shown failing when the rule is removed.

## How we will know it works

- Unit and integration tests for tool schemas, the task state machine, and token validation (wrong audience, expired, missing scope, wrong issuer).
- A scripted stdio run that starts the server and walks a task through `working`, `input_required`, `completed`.
- A manual run in Claude Code 2.1.304+ in an interactive session, checking `/tasks` and the elicitation dialog for stage 1, and `/mcp` sign-in and a step-up scope challenge for stage 2.
- The autonomous script obtains a `client_credentials` token, lists environments, runs a staging deploy to completion as a task, and is refused with `insufficient_scope` on a production deploy.
- Claude Code, signed in as the interactive client without `mcp:deploy:production`, hits the `403` on a production deploy; after adding the scope to `oauth.scopes` and signing in again, the deploy pauses for approval and completes.

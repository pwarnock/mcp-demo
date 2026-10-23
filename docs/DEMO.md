# Demo playbook

A scripted walkthrough of the release-manager server in Claude Code. Each act says what to type, what you should see, and what it shows. Nothing real is deployed.

## What the demo covers

| Feature | Tool | Where to read it | Seen in Claude Code (2.1.309, 2026-10-23) |
| - | - | - | - |
| Plain read-only tool | `list_environments` | `src/tools.ts` | Yes |
| MCP Tasks | `deploy_release` | `src/tasks.ts`, `src/deploy.ts` | Yes: the task shows in `/tasks` |
| Elicitation inside a task (form mode) | `deploy_release` to production | `src/deploy.ts` (`awaitApproval`) | Yes: approval dialog; accept completes, decline cancels |
| Elicitation outside a task (form mode) | `rollback_release` | `src/tools.ts` | Yes: confirmation dialog |
| Elicitation, URL mode, secret sent to a secure service | `set_registry_token` | `src/token-flow.ts`, `src/secret-sink.ts`, `src/fake-vault.ts` | Yes: the vault printed the name and length, never the value |
| Restart recovery (an interrupted task reports `failed`) | `deploy_release` | `src/store.ts` | **Not observed in Claude Code.** A `kill -9` restart over raw stdio (2026-10-23) and `tests/stdio.e2e.test.ts` both show `failed` |

Details and dates of each observation are in `docs/superpowers/spikes/2026-10-23-stage1-claude-code-run.md`.

## Before you start

1. Run `bun install`, then `bun run test` once. The suite should pass.
2. Register the server (use your own path for `<path-to-repo>`):

   ```bash
   claude mcp add release-manager -e STEP_DELAY_MS=5000 -- bun <path-to-repo>/src/main.ts
   ```

   `STEP_DELAY_MS=5000` slows each of the four deploy steps to 5 seconds, so a staging deploy takes about 20 seconds and you can watch it in `/tasks`. Leave it out for the default of 1.5 seconds per step.
3. Start a **fresh interactive** `claude` session. A running session keeps the old server process. Tasks do not work in `claude -p`, the VS Code extension or the desktop app.
4. Run `/mcp` and check `release-manager` is connected.
5. Use **manual permission mode** for Act 5. In auto mode the session's classifier denied `set_registry_token` as a secret-store write before the call reached the server. Whether to allow it is your call.

## The walkthrough

### Act 1: a plain tool
Say: "List the environments."
You should see: a table with `web` and `api` in `dev`, `staging` and `production`.
Shows: the baseline. Every other act builds on this.

### Act 2: a task
Say: "Deploy web 2.0.0 to staging."
You should see: the deploy appear in `/tasks` as `working` with a step message (`Step 2 of 4: build`), then `completed`. No questions are asked.
Shows: the tool returned a task handle immediately instead of blocking, and Claude Code polled it. Behind the scenes the server returned `resultType: "task"`; the SDK has no tasks runtime, so `src/tasks.ts` implements it by hand.

### Act 3: approval inside a task
Say: "Deploy web 2.0.0 to production."
You should see: the task move to `input_required`. Close `/tasks` to see the approval dialog.
- Accept: the deploy finishes and production shows 2.0.0.
- Decline, or press Escape: the task ends `cancelled`, "Approval declined", and nothing changes. Escape counts as an answer ("cancel"), not a way out.
Shows: elicitation nested in a task. The dialog is modal: you cannot run `/exit` or Ctrl+C while it is open.

### Act 4: confirmation outside a task
Say: "Roll web in production back to 1.2.0."
You should see: a confirmation dialog. Nothing changes until you accept. Ask for the environments afterward to check.
Shows: the 2026-07-28 pattern for elicitation outside a task. The server returns an `input_required` result with a sealed `requestState`, the client asks you, then retries the same call with your answer. The state is HMAC-signed because the client can tamper with it.

### Act 5: URL mode and a secret the model never sees
Say: "Set the registry token."
You should see: Claude Code ask before opening a link like `http://127.0.0.1:<port>/connect/<long random string>`. Accept, paste any made-up value on the page, and submit. The tool then says "Registry token saved. It was not shown to the model."
Shows: the page's handler passes the token straight to a secure service and keeps no copy. The only thing the model learns is that delivery succeeded.

To watch the token arrive, run a vault in its own terminal and register the server against it:

```bash
bun <path-to-repo>/scripts/fake-vault.ts     # terminal 1: 127.0.0.1:8787, bearer token demo-vault-token
claude mcp remove release-manager            # terminal 2
claude mcp add release-manager -e STEP_DELAY_MS=5000 -e SECRET_SINK_URL=http://127.0.0.1:8787/secrets -e SECRET_SINK_AUTH=demo-vault-token -- bun <path-to-repo>/src/main.ts
```

Start a fresh `claude` session and repeat Act 5. Terminal 1 should print `[fake-vault] stored "registry-token" (N chars)`, where N is the length of what you pasted. It never prints the value. Without these settings the server uses a built-in fake vault and logs the same line to its own stderr, which Claude Code does not normally show.

### Act 6 (optional): restart recovery
Say: "Deploy api 2.1.0 to staging", then quit Claude Code within about 15 seconds (with the default step delay the deploy is over in 6 seconds, so use the slow setting). Start `claude` again and open `/tasks`. The task should show `failed`, "Server restarted before the task finished", and staging api should not show 2.1.0.
This has not been observed in Claude Code; it was checked over raw stdio with a `kill -9` and a restart. The production approval dialog cannot be used for this, because it cannot be closed without answering it.

## Edges worth pointing out

- **A dialog is not authorization.** Claude Code's `Elicitation` hook can answer a request with no dialog, and a task that needs input is cancelled in non-interactive sessions. Real authorization has to live in the server (the stage 2 design uses scopes).
- **The host sits between the model and the server.** The classifier denial in Act 5 happened before the server saw anything.
- **Form mode must not carry secrets**, which is why the token uses URL mode.
- **`accept` in URL mode means "I agreed to open the link", not "I finished".** The server learns the outcome itself, which is why the call waits (up to two minutes) for the page to be submitted.
- **On stdio the "same user" protection is only the one-time link.** A hosted server would check the signed-in user, as the spec's phishing guidance requires.
- **The SDK adds an empty `content` array to the task result.** Claude Code accepted it.

## Not in this demo

- **The "use" half of the secret.** Nothing reads the stored token back and calls an API with it. A real server would, in a tool such as `publish_release`: fetch the credential, call the API, and return only the outcome.
- **Stage 2:** Streamable HTTP, OAuth, and interactive versus autonomous clients. It is designed in `docs/superpowers/specs/2026-10-23-ts-mcp-demo-design.md`.
- **The `Elicitation` hook** (auto-answering dialogs) and MCP apps with rich UI.

## Reset and cleanup

- Reset to the seed versions: stop all Claude Code sessions, then delete `.state/state.json` in the repo. If you set `STATE_PATH`, delete that file instead.
- Remove the server: `claude mcp remove release-manager`.
- Stop the vault with Ctrl+C in its terminal.

## If something goes wrong

| What you see | Likely reason |
| - | - |
| The new tool is missing | The session predates registration or an update. Start a fresh `claude` session. |
| `deploy_release needs a client that supports the MCP tasks extension.` | The session does not declare tasks (`claude -p`, VS Code extension, desktop app). Use an interactive terminal session. |
| `set_registry_token` is denied before anything happens | Auto mode's classifier. Check the permission mode. |
| The token page answers 403 | It refused the request's Host, Origin or Sec-Fetch-Site headers. Open the link the tool gave you, in a normal browser tab, on the same machine. |
| The token page says "not saved" (502) | The secure service was unreachable or refused the secret. The same link still works once it is back. |
| "Timed out waiting for the token page" | You accepted the prompt but did not submit the page within two minutes. Run the tool again. |
| A link says "not found" or "expired" | Links work once and expire after five minutes. Run the tool again for a new one. |
| Nothing shows in the vault terminal | The session was not restarted after re-registering, or the `-e` settings were not applied. |

## Where to read more

- Design: `docs/superpowers/specs/2026-10-23-ts-mcp-demo-design.md`
- Stage 1 plan: `docs/superpowers/plans/2026-10-23-stage1-stdio.md`
- How the SDK was found to be able to serve tasks: `docs/superpowers/spikes/2026-10-23-tasks-spike.md`
- Dated results from Claude Code: `docs/superpowers/spikes/2026-10-23-stage1-claude-code-run.md`

# Stage 1 Claude Code run (Task 8)

Status: **automated smoke check done; interactive items a, b, c, d and e confirmed by Peter on 2026-10-23; f not observed (Peter chose to stop testing; see its row).** The interactive items need a person in a Claude Code 2.1.304+ session (tasks are unavailable in `claude -p`), so they could not be run by the agent that built this.

## Done: print-mode smoke check (Claude Code 2.1.309, 2026-10-23)

Ran `claude -p` against the server through a throwaway `--mcp-config` file with `--strict-mcp-config`, allowing only `list_environments` and `deploy_release`:

- Claude Code connected over stdio on the 2026-07-28 protocol and found the tools.
- `list_environments` returned the seed versions.
- `deploy_release` returned `deploy_release needs a client that supports the MCP tasks extension.` That is expected: print mode does not declare the tasks extension, which matches the Claude Code docs and confirms the capability check works with the real client.

## Pending: interactive checklist

Add the server (`claude mcp add release-manager -- bun <path-to-repo>/src/main.ts`), start an interactive `claude` session, and record what happened beside each item.

| # | Check | Result |
| - | - | - |
| a | `list_environments` works. | Peter, 2026-10-23, Claude Code 2.1.309: ran `list_environments` in an interactive session (reported as run; output not described). |
| b | A staging `deploy_release` appears in `/tasks` and completes. Does Claude Code accept the task result even though the SDK adds `"content": []` to it? | Peter, 2026-10-23, Claude Code 2.1.309: the task shows up in `/tasks`, so Claude Code accepts the task result even with the SDK-added `"content": []`. Completion was not reported. |
| c | A production `deploy_release` pauses at `input_required`; close `/tasks` and the approval dialog appears. | Peter, 2026-10-23, Claude Code 2.1.309: the production deploy pauses and the approval dialog appears. This confirms elicitation inside a task. |
| d | Declining the approval ends the task `cancelled`. | Peter, 2026-10-23, Claude Code 2.1.309: accepting the approval works and declining cancels the task (as reported: "accepting works, declining cancels"). |
| e | `rollback_release` shows a confirmation dialog and changes nothing until you accept. Does Claude Code answer a plain `input_required` result on `tools/call` (not only the task form)? | Peter, 2026-10-23, Claude Code 2.1.309: the confirmation dialog appears and the rollback works (as reported: "rollback works, confirmation dialog appears"). This shows Claude Code answers a plain `input_required` result on `tools/call`, outside a task. |
| f | Restart Claude Code mid-task and note what `/tasks` shows. (A task interrupted by a server restart should report `failed`.) | Not observed. On 2026-10-23 Peter force-closed the tab with a production deploy waiting for approval but did not reopen Claude Code to look, and chose to stop. Restart recovery (an interrupted task reports `failed`) is covered by `tests/stdio.e2e.test.ts` only. Also seen: Escape in the approval dialog answers cancel, so the task ends `cancelled` with versions unchanged; the dialog cannot be skipped with `/exit` or Ctrl+C. |
| g | `set_registry_token` (URL-mode elicitation): Claude Code shows the full URL and asks consent, opens the browser, and after you paste a made-up token the tool reports it saved. Does the dialog show the whole URL? Does Esc end it without storing anything? | |

If (c) or (e) cannot be demonstrated at all, stop and report. Otherwise, for any difference from the design, adapt the server where the spec allows, or record the gap in the README.

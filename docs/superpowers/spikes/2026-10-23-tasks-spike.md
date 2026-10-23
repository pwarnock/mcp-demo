GATE: GO. SDK 2.4.0 can serve the tasks extension on its custom-handler path; `mcp-durable-tasks` is not needed.

# Tasks extension spike (Task 2)

Run on 2026-10-23 with `@modelcontextprotocol/server` and `@modelcontextprotocol/client` 2.4.0, Bun 1.4.4. Throwaway code: `spikes/tasks/` (`server.ts`, `server-lowlevel.ts`, `drive.ts`, `drive-raw.ts`). Evidence below is from `bun spikes/tasks/drive-raw.ts` (raw JSON-RPC lines over stdio) and `bun spikes/tasks/drive.ts` (SDK client).

## A. Can a `tools/call` handler return `resultType: "task"` over the wire? Yes.

A handler registered with `registerTool` that returns `{ resultType: 'task', taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs }` (cast `as never`; the handler type does not allow it) produced this on stdout:

```
{"result":{"content":[],"resultType":"task","taskId":"t1","status":"working","createdAt":"…","lastUpdatedAt":"…","ttlMs":null,"pollIntervalMs":500,"_meta":{"io.modelcontextprotocol/serverInfo":{…}}},"jsonrpc":"2.0","id":2}
```

Caveat: the SDK adds `"content": []` to the result. A low-level `setRequestHandler('tools/call', …)` (`server-lowlevel.ts`) does the same, so it cannot be avoided at the handler level. Claude Code's docs say a task object "has no `content` array" and that `resultType: "task"` is what marks it as a task; whether Claude Code tolerates the extra empty `content` is unverified and is checked in Task 8.

The SDK's own client rejects task results (`SdkError: Unsupported result type 'task' for tools/call`), so tests that need to see a task must read the raw JSON-RPC response, as `drive-raw.ts` does, not call `client.callTool`.

## B. Do `tasks/get`, `tasks/update`, `tasks/cancel` reach custom handlers? Yes.

```ts
mcp.server.setRequestHandler(method, { params: ZodSchema, result: ZodSchema }, async (params, ctx) => result);
```

Verified for all three methods over stdio. `tasks/get` returned the handler's object with `resultType: "complete"`; `tasks/update` and `tasks/cancel` returned `{}` (the SDK adds `_meta` server info). A missing `taskId` is refused by the params schema with `-32602` and the message `Invalid params for tasks/get: taskId: Invalid input: expected string, received undefined`.

## C. Capabilities. Yes.

- Server advertises the extension by passing it in the constructor capabilities: `new McpServer(info, { capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } } })` (cast `as never` in the spike; whether the cast is needed is unverified). `server/discover` returned `"capabilities":{"tools":{"listChanged":true},"extensions":{"io.modelcontextprotocol/tasks":{}}}` and `supportedVersions: ["2026-07-28"]`.
- A handler reads the request's declared client capabilities from `ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.['io.modelcontextprotocol/tasks']`. Seen in the handler log for `tools/call`, `tasks/get`, `tasks/update` and `tasks/cancel`. Absent capabilities arrive as `{}`.

## Other facts learned

- Serve with `serveStdio(factory, { legacy: 'reject', onerror })` from `@modelcontextprotocol/server/stdio`. A 2025-era `initialize` is refused with a modern-only error.
- The SDK client defaults to the legacy `initialize` handshake. To talk to a modern server it needs `new Client(info, { capabilities: { extensions: {…} }, versionNegotiation: { mode: { pin: '2026-07-28' } } })`.
- Every modern request carries `_meta` keys `io.modelcontextprotocol/protocolVersion`, `…/clientInfo` and `…/clientCapabilities`; raw drivers must send them.

## D. `mcp-durable-tasks`

Not evaluated; A to C were all yes.

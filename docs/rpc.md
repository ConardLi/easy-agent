# RPC mode

`eagent --rpc` serves the [session SDK](./sdk.md) over JSON-RPC 2.0 on stdin and stdout, for editors, desktop apps, and programs not written in Node.js. One process serves one workspace, its current directory, and can hold several sessions at once.

The protocol is **experimental** in the 0.x releases. It carries a version (`protocolVersion`, currently `1`): adding methods, params, result fields, or event fields keeps the version; removing or changing the meaning of any of them bumps it. Both sides must ignore fields they do not know.

The machine-readable definition is [rpc-protocol.schema.json](./rpc-protocol.schema.json). It is generated from `src/rpc/protocol.ts` (`npm run rpc:schema`), and the protocol tests validate every message the server sends against it.

A complete client in about 80 lines of plain Node.js is in [examples/rpc-client.mjs](../examples/rpc-client.mjs).

## Transport

- One JSON-RPC 2.0 message per line, UTF-8, in both directions. Every message carries `"jsonrpc": "2.0"`. Batches are not supported.
- stdout carries protocol messages only. Diagnostics go to stderr; anything else in the process that writes to stdout is redirected there too.
- Requests are handled concurrently: a long `session/send` does not hold up `session/interrupt` or `session/respond`. Responses can arrive in any order; match them by `id`.
- A request without `id` is a notification: it runs, and nothing is sent back.
- The server never sends requests. Everything it needs from the client, such as permission decisions, arrives as an event the client answers with `session/respond`.
- The process exits with 0 after answering `shutdown` or when stdin closes. Before exiting it closes every session, which ends running turns, and answers the requests still in flight. An internal failure exits with 1 after writing the error to stderr.

## Lifecycle

```text
client                                   server
  │  initialize {protocolVersion: 1}        │  bootstraps the workspace
  │ ─────────────────────────────────────▶ │
  │ ◀───────────────────────────────────── │  {protocolVersion, workspace, capabilities}
  │  session/create                         │
  │ ─────────────────────────────────────▶ │
  │ ◀── session/event (state_snapshot) ─── │
  │ ◀───────────────────────────────────── │  {sessionId, state}
  │  session/send {sessionId, input}        │
  │ ─────────────────────────────────────▶ │
  │ ◀── session/event (turn_started, text_delta, tool_started, …) ──
  │ ◀── session/event (request_opened) ─── │  a tool needs confirmation
  │  session/respond {requestId, response}  │
  │ ─────────────────────────────────────▶ │
  │ ◀── session/event (…, turn_completed) ─│
  │ ◀───────────────────────────────────── │  TurnResult for session/send
  │  shutdown                               │
  │ ─────────────────────────────────────▶ │  exits 0
```

Requests sent while `initialize` is running wait for it to finish, so a client may pipeline them. The workspace bootstrap (trust, `.env`, skills, agents, plugins, sandbox) runs during `initialize`, so the client chooses the trust mode before anything configured by the workspace executes.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `clientInfo?`, `trust?`, `interactions?`, `services?` | `protocolVersion`, `sessionProtocolVersion`, `serverInfo`, `workspace`, `capabilities` |
| `runtime/capabilities` | | built-in commands, skills, user commands, sub-agent types, output style |
| `session/create` | `model?`, `permissionMode?`, `persist?` | `sessionId`, `state` |
| `session/resume` | `sessionId?` (default: latest), `model?`, `permissionMode?` | `sessionId`, `state` |
| `session/list` | `limit?` | `sessions`: saved sessions, most recent first |
| `session/read` | `sessionId` | `summary`, `messages` of a saved session, without opening it |
| `session/rename` | `sessionId`, `title` (empty clears it) | `session`: the updated summary |
| `session/fork` | `sessionId`, `title?` | `session`: summary of the copy |
| `session/delete` | `sessionId` | `{}`; the session must not be open |
| `session/send` | `sessionId`, `input`, `queue?` | `TurnResult`, once the turn and its follow-up turns end |
| `session/command` | `sessionId`, `name`, `args?` | `TurnResult` of a local command such as `mode` or `compact` |
| `session/respond` | `sessionId`, `requestId`, `response` | `outcome`: `resolved` or `stale` |
| `session/interrupt` | `sessionId` | `outcome`: `permission_denied`, `question_cancelled`, `turn_aborted`, or `idle` |
| `session/state` | `sessionId` | `SessionState` |
| `session/shell` | `sessionId`, `command` | `output`, `isError`: a shell command run without the model, under the Bash tool rules |
| `session/close` | `sessionId` | `{}` |
| `shutdown` | | `{}`, then the process exits |

`initialize` params:

- `protocolVersion` (required): the version the client speaks. An unsupported version fails with `-32002` and `data.supported`.
- `trust`: `"persisted"` (default) uses the trust decision saved for the workspace. `"session"` trusts it for this process only, like `--trust-project-config`. An untrusted workspace ignores project settings, `.env` credentials, hooks, project MCP servers, plugin executables, and model profiles; `workspace.ignoredProjectConfig` lists what was ignored.
- `interactions`: the request kinds the client answers, from `permission`, `plan_approval`, `question`. Default: all three. Kinds left out get the safe default without being published: permission and plan approval are denied, questions are cancelled.
- `services`: `"background"` (default) connects MCP servers and plugin services after answering, so a slow server does not delay startup; their tools appear once connected. `"wait"` connects them before answering.

`session/send` with `queue: true` waits for a running turn to finish instead of failing with `busy`. Without it, a send while the session is busy fails with error data code `busy`.

`/resume <id>` sent as input switches the session to another saved conversation: a `session_replaced` event carries the new id, which addresses the session from then on. The old id answers every call with data code `replaced` and `data.replacedBy`.

Sessions opened on a connection run in this process. Tool-turn budgets follow the terminal: 200 by default, or the `maxTurns` setting.

## Events

The server sends `session/event` notifications; `params` is one session event exactly as the SDK produces it, with `type`, `sessionId`, and a per-session sequence number `seq`. Each session's events start with a `state_snapshot`, sent before the response that opened the session. The event types and their fields are listed in the [SDK documentation](./sdk.md#events).

`runtime/log` notifications carry startup warnings and errors: `{ level: "warn" | "error", message }`. They are also written to stderr.

## Interaction requests

A request the client must answer arrives as a `request_opened` event:

```json
{"jsonrpc":"2.0","method":"session/event","params":{"type":"request_opened","sessionId":"…","seq":12,
 "request":{"kind":"permission","id":"…","turnId":"…","toolUseId":"toolu_…","toolName":"Write",
            "input":{"file_path":"notes.txt","content":"…"},"summary":"…","risk":"…","ruleHint":"Write"}}}
```

`toolUseId` matches the `toolUseId` of the `tool_started` event for the same call. Answer with `session/respond`:

| `kind` | `response` |
| --- | --- |
| `permission` | `{ "decision": "allow_once" \| "allow_always" \| "deny" }` |
| `plan_approval` | `{ "decision": "approve", "clearContext"?: true, "acceptEdits"?: true }` or `{ "decision": "reject", "feedback"?: "…" }` |
| `question` | `{ "answers": { "<question>": "<label>" } }` or `{ "cancelled": true }` |

A `request_resolved` event follows when the request stops being pending, whether by a response, `session/interrupt`, the end of the turn, or the session closing. A response to a request that is no longer pending returns `outcome: "stale"`. Pending requests are also listed in `SessionState.pendingRequests`, so a client that reconnects its UI can call `session/state` and show them again.

Deny rules, the sandbox, and the Auto Mode classifier decide before a request is published. A client cannot approve a call that settings deny.

## Errors

| Code | Meaning | `data` |
| --- | --- | --- |
| `-32700` | The line is not valid JSON | |
| `-32600` | Not a JSON-RPC 2.0 request | |
| `-32601` | Unknown method | |
| `-32602` | Invalid params, or a response that does not answer the request's kind | `issues` for schema failures |
| `-32603` | Internal error | |
| `-32000` | The session SDK rejected the call | `code`: `busy`, `closed`, `replaced`, `not_found`, `invalid_argument`, `already_open`, `session_restore`, `session_storage`, `permission_settings` |
| `-32001` | Called before `initialize` | |
| `-32002` | Unsupported protocol version | `supported` |
| `-32003` | No open session with this id on this connection | `sessionId` |
| `-32004` | `initialize` called twice | |

## Example

```bash
cd /path/to/project
node /path/to/easy-agent/examples/rpc-client.mjs "Explain the build setup"
```

The example starts `eagent --rpc`, initializes, opens a session, sends the prompt, prints the streamed reply, asks on the terminal when a tool needs confirmation (or approves everything with `--yes`), and shuts the server down.

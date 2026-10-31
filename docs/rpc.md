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
| `initialize` | `protocolVersion`, `clientInfo?`, `trust?`, `interactions?`, `services?`, `harness?` | `protocolVersion`, `sessionProtocolVersion`, `serverInfo`, `workspace`, `capabilities` |
| `runtime/capabilities` | | built-in commands, skills, user commands, sub-agent types, output style |
| `runtime/inventory` | | skills, commands, sub-agents, output styles, MCP servers, plugins, hooks, rule files, and tools, each with its source, path, whether it is in effect and why not, and token estimates; see the [SDK inventory](./sdk.md#inventory) |
| `runtime/harness` | `name?`, `spec?` | an Agent resolved like `getHarness()`: every setting with its value and source, ignored values and reasons, issues, and a hash; see the [SDK](./sdk.md#agents). Experimental |
| `runtime/reload` | | registry sizes after reloading skills, commands, sub-agents, output styles, and plugins from disk, plugin MCP servers started and stopped, plugin errors; open sessions use the new set from their next turn |
| `mcp/approve` | `name`, `approved`, `scope?` (`user`, `project`, `local`; default `local`) | `name`, `approved`, `scope`, `status` (null when not running), `error?`; saves the decision for a `.mcp.json` server and connects or stops it. Fails with data code `untrusted` in an untrusted workspace |
| `mcp/reconnect` | `name` | `name`, `status`, `error?`, `toolCount` |
| `plugins/list` | | `installed` (version, `enabled`, `scope`, components, `hasExecutableComponents`, `executablesTrusted`, warnings), `available` from the registered marketplaces, `marketplaces`, `errors`, `projectTrusted` |
| `plugins/preview` | `pluginId` (`name@marketplace`) | `pluginId`, `version`, `fingerprint`, `description?`, `components`, `hasExecutableComponents`, `warnings`, `errors`; fetches and validates without installing. Show it to the user before installing |
| `plugins/install` | `pluginId`, `scope?` (default `user`), `fingerprint` | the `plugins/list` view; `fingerprint` comes from the preview the user confirmed, and content that changed since fails with data code `plugin` |
| `plugins/update` | `pluginId`, `scope?`, `fingerprint` | the `plugins/list` view |
| `plugins/enable`, `plugins/disable` | `pluginId`, `scope?` (default `user`) | the `plugins/list` view. In an untrusted workspace the `project` and `local` scopes fail with data code `untrusted` (also for install and update), since those settings would not apply |
| `plugins/uninstall` | `pluginId`, `scope?`, `keepData?` | the `plugins/list` view; the plugin's files go when no scope still has it installed |
| `marketplace/add` | `source`: a local directory, a Git URL, or GitHub `owner/repo` | the `plugins/list` view |
| `marketplace/update`, `marketplace/remove` | `name` | the `plugins/list` view |
| `config/read` | | every settings source (path, whether it applies, display-safe values), the effective value, source, and reload policy of each key, the model profiles, and the keys only user settings may set |
| `config/write` | `scope` (`user`, `project`, `local`), `key`, `value` (`null` deletes) | `reload`; validated before writing, `[redacted]` inside the value keeps the stored secret, `mode` and `autoMode` only in `user` |
| `workspace/trust` | `trusted` | `trusted`; saved trust applies when the next process starts |
| `models/check` | `model` (profile id or model name) | `ok`, `protocol`, `model`, `latencyMs`, and `error` without credentials |
| `models/list` | `model` | `models`: ids from the provider's model list |
| `session/create` | `model?`, `permissionMode?`, `persist?` | `sessionId`, `state` |
| `session/resume` | `sessionId?` (default: latest), `model?`, `permissionMode?` | `sessionId`, `state` |
| `session/list` | `limit?` | `sessions`: saved sessions, most recent first |
| `session/read` | `sessionId` | `summary`, `messages` of a saved session, without opening it |
| `session/rename` | `sessionId`, `title` (empty clears it) | `session`: the updated summary |
| `session/fork` | `sessionId`, `title?`, `fromMessage?` (a checkpoint id: the copy ends just before that prompt) | `session`: summary of the copy, which keeps the file checkpoints of its turns |
| `session/delete` | `sessionId` | `{}`; the session must not be open |
| `session/send` | `sessionId`, `input`, `queue?`, `images?` | `TurnResult`, once the turn and its follow-up turns end |
| `session/command` | `sessionId`, `name`, `args?` | `TurnResult` of a local command such as `mode` or `compact` |
| `session/respond` | `sessionId`, `requestId`, `response` | `outcome`: `resolved` or `stale` |
| `session/interrupt` | `sessionId` | `outcome`: `permission_denied`, `question_cancelled`, `turn_aborted`, or `idle` |
| `session/state` | `sessionId` | `SessionState` |
| `session/shell` | `sessionId`, `command` | `output`, `isError`: a shell command run without the model, under the Bash tool rules |
| `session/setPermissionMode` | `sessionId`, `mode` | `{}`; takes effect right away, also while a turn runs |
| `session/setModel` | `sessionId`, `model` (`"default"` clears the override) | `{}`; right away, emits `model_changed` |
| `session/setThinking` | `sessionId`, `thinking`: `"on"`, `"off"`, or a token budget | `{}`; emits `thinking_changed` |
| `session/setEffort` | `sessionId`, `effort`: `low`, `medium`, `high`, `max`, or `null` for the model default | `{}`; emits `thinking_changed` |
| `session/stopBackgroundAgent` | `sessionId`, `agentId` | `stopped`: false when the session did not start that agent |
| `session/context` | `sessionId` | context window, `used`, `free`, and `categories` (system, tools, mcp, skills, plugins, rules, messages) with items; the totals match `/context`, see the [SDK context breakdown](./sdk.md#context-breakdown) |
| `session/checkpoints` | `sessionId` | `checkpoints`: the prompts the conversation can go back to, oldest first, each with `id`, `messageIndex` in `SessionState.messages`, `prompt`, and `files` (whether the files can be restored) |
| `session/rewind` | `sessionId`, `toMessage?` (checkpoint id), `scope` (`files`, `conversation`, `both`), `dryRun?` | `scope`, `dryRun`, `checkpoint`, `messagesRemoved`, `files` (`paths`, `insertions`, `deletions`); restores to just before the checkpoint's prompt and emits `session_rewound`. Without `toMessage`, a `files` rewind undoes every edit the session tracked. Fails with data code `busy` while a turn runs, `not_found` for an unknown checkpoint or one without file checkpoints. See the [SDK rewind](./sdk.md#checkpoints-and-rewind) |
| `session/close` | `sessionId` | `{}` |
| `shutdown` | | `{}`, then the process exits |

`initialize` params:

- `protocolVersion` (required): the version the client speaks. An unsupported version fails with `-32002` and `data.supported`.
- `trust`: `"persisted"` (default) uses the trust decision saved for the workspace. `"session"` trusts it for this process only, like `--trust-project-config`. An untrusted workspace ignores project settings, `.env` credentials, hooks, project MCP servers, plugin executables, and model profiles; `workspace.ignoredProjectConfig` lists what was ignored.
- `interactions`: the request kinds the client answers, from `permission`, `plan_approval`, `question`. Default: all three. Kinds left out get the safe default without being published: permission and plan approval are denied, questions are cancelled.
- `services`: `"background"` (default) connects MCP servers and plugin services after answering, so a slow server does not delay startup; their tools appear once connected. `"wait"` connects them before answering.
- `harness` (experimental): the Agent the sessions use, `{ name }` from `harnesses` in the user settings or `{ spec }` resolved over its `extends`; not both. Defaults to the `--harness` the server was started with, then `default`. An Agent that does not resolve fails `initialize` with `-32000` and data code `harness`; the client can call `initialize` again. See [Agent specs](./configuration.md#agent-specs-harnesses).

`session/send` accepts `images`, a list of `{ data, mimeType }` with base64 PNG, JPEG, GIF, or WebP data; the model sees them after the text. With `queue: true` it waits for a running turn to finish instead of failing with `busy`. Without it, a send while the session is busy fails with error data code `busy`.

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
| `-32000` | The session SDK rejected the call | `code`: `busy`, `closed`, `replaced`, `not_found`, `invalid_argument`, `already_open`, `session_restore`, `session_storage`, `permission_settings`, `provider`, `untrusted`, `plugin` |
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

# Session SDK

`eagent/sdk` runs Easy Agent sessions inside another Node.js program. Programs in other languages and desktop apps can use the same sessions over JSON-RPC with [RPC mode](./rpc.md), and editors through the [Agent Client Protocol](./acp.md). The terminal UI and headless mode (`eagent -p`) are built on the same API, so an embedded session behaves like a terminal session: the same tools, permission rules, sandbox, hooks, skills, sub-agents, transcripts, and resume.

The SDK is **experimental** in the 0.x releases. The event and request shapes carry a protocol version (`SESSION_PROTOCOL_VERSION`); additive changes keep it, removals and changed meanings bump it.

## Quick start

```ts
import { createAgentRuntime } from "eagent/sdk";

const runtime = await createAgentRuntime({ cwd: "/path/to/project" });
const session = await runtime.createSession();

session.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "request_opened" && event.request.kind === "permission") {
    // Ask the user, then answer:
    session.respond(event.request.id, { decision: "allow_once" });
  }
});

const result = await session.send("Explain the build setup in this repository.");
console.log("\nstopped:", result.reason);

await runtime.dispose();
```

Requires Node.js 22 or newer. The package is ESM-only. Message types in the declarations come from `@anthropic-ai/sdk`; install it as a dev dependency if you type-check with `skipLibCheck` off.

## Concepts

| Object | Scope | Responsibility |
| --- | --- | --- |
| `AgentRuntime` | One workspace | Bootstraps the workspace (trust, `.env`, skills, agents, output styles, commands, plugins, sandbox, execution settings), starts MCP and plugin services, opens and lists sessions |
| `AgentSession` | One conversation | Runs turns, publishes events, holds pending interaction requests, writes the transcript, runs plan follow-ups, wakes up for background results |

A **turn** is one input and all the work that follows it: model requests, tool calls, and confirmations. `send()` resolves when the turn ends, including follow-up turns the session runs on its own after a plan decision.

### Process model

Settings layers, the workspace `.env`, and the extension registries are process-wide, so a process runs **one runtime at a time**; `createAgentRuntime()` rejects with `runtime_active` otherwise. A runtime can hold **several sessions at once**: each keeps its conversation state (file checkpoints, plan file, background notifications, `/think` and `/effort`, task mode, progress of running tools) separate from the others. An application that works with several workspaces runs one process per workspace.

Only one session in a process can lead an Agent Team at a time.

## Runtime

```ts
const runtime = await createAgentRuntime({
  cwd,                       // absolute workspace path
  trust: "persisted",        // or "session": trust this workspace for this process only
  flagSettings: { model: "sonnet" }, // command-line settings layer; omit to leave it unchanged
  pluginDirs: [],            // extra plugin directories
  services: { mcpServers: true, wait: true }, // or false, then call runtime.startServices()
  logger: { warn, error },   // startup warnings; defaults to the console
});
```

`runtime.report` tells you whether the workspace is trusted, which project configuration an untrusted workspace ignored, how many project credential overrides were ignored, and why the sandbox is unavailable, if it is.

| Method | Purpose |
| --- | --- |
| `createSession(options?)` | Start a new conversation |
| `resumeSession(sessionId?, options?)` | Reopen a saved conversation; without an id, the most recent one |
| `listSessions(limit?)` / `readSession(id)` | Saved conversations of the workspace, without opening them. Summaries carry the first prompt the user typed and the title, if set |
| `renameSession(id, title)` | Set a saved session's title; an empty title clears it |
| `forkSession(id, { title? })` | Copy a saved conversation into a new session. The copy has no file checkpoints, so `/rewind` cannot go back past the fork |
| `deleteSession(id)` | Delete a saved session's transcript, title, file checkpoints, and task list; close it first |
| `getSession(id)` / `listOpenSessions()` | Sessions currently open |
| `getCapabilities()` | Built-in commands, invocable skills, user commands, sub-agent types, output style |
| `resolveModel()` | The model a session uses when none is given |
| `startServices(options?)` | Connect MCP servers and plugin services |
| `connectMcpServers(servers)` | Connect more MCP servers, such as the ones an editor supplies; a name that is already configured keeps its server |
| `hasModelCredentials(model?)` | Whether requests for the model have an API key, an auth header, or a custom endpoint |
| `readConfig()` | Settings sources, effective values with their source and reload policy, and model profiles; inline secrets come back as `[redacted]`, `${VAR}` references as written |
| `writeConfig(scope, key, value)` | Set or (with `null`) delete one key in user, project, or local settings, after validation; open sessions pick up permission rules right away |
| `setWorkspaceTrust(trusted)` | Save or revoke trust for the workspace; it applies to the next runtime |
| `checkModel(model)`, `listModels(model)` | Send a one-token request through a model handle; list the models its provider offers |
| `getInventory()` | Everything the runtime has loaded, see [Inventory](#inventory) |
| `reload()` | Reload skills, commands, sub-agents, output styles, and plugins from disk. Open sessions use the new set from their next turn; returns the registry sizes, plugin MCP servers started and stopped, and plugin errors |
| `approveMcpServer(name, approved, scope?)` | Approve or reject a server from the project's `.mcp.json`. The decision is saved in `enabledMcpjsonServers` or `disabledMcpjsonServers` of `scope` (default `local`); an approved server connects right away, a rejected one stops. Rejects with `untrusted` in an untrusted workspace |
| `reconnectMcpServer(name)` | Drop a registered MCP server's connection and connect again; returns the status, the error if it failed, and the tool count |
| `dispose()` | Close every session and free the process for another runtime |

### Inventory

`getInventory()` returns one list per kind: `skills`, `commands`, `agents`, `outputStyles`, `mcpServers`, `plugins`, `hooks`, `rules` (AGENT.md and AGENTS.md files and the memory index), and `tools`. Every item has:

| Field | Meaning |
| --- | --- |
| `id` | Unique within its list |
| `kind`, `name` | What it is |
| `source` | `built-in`, `user`, `project`, `local`, `flag`, `policy`, or `plugin`; `pluginId` names the plugin |
| `path` | The file that defines it, when there is one |
| `enabled` | Whether sessions use it: listed to the model, connected, loaded, or run |
| `reason` | Why it is off or limited, such as an untrusted workspace, `claudeMdExcludes`, or hooks turned off |

Items that occupy context carry token counts as `{ value, estimated }`: a skill's line in the skill list and its body, a sub-agent's line, an output style's prompt, a rule file, a tool's schema. Counts come from character lengths, so `estimated` is `true`. MCP servers report `status` (`connected`, `pending`, `failed`, `disabled`, `awaiting_approval`, `rejected`, or `ignored` in an untrusted workspace), their tools, and the error when connecting failed. Tools report whether ToolSearch defers them for the runtime's model. Project configuration an untrusted workspace ignores still appears, disabled, with the reason.

## Sessions

```ts
const session = await runtime.createSession({
  model: "claude-sonnet-4-5",          // default: the workspace model setting
  permissionMode: "default",           // "default" | "plan" | "auto"
  interactions: ["permission", "plan_approval", "question"], // what your UI answers
  handlers: {},                        // automatic answers, see below
  autoWake: true,                      // run a turn when a background result arrives
  persist: true,                       // write the transcript and file checkpoints; false keeps nothing on disk
});
```

| Method | Purpose |
| --- | --- |
| `send(input, { images? })` | Run a turn. Text goes to the model; `/command` runs a local command, a skill, or a user command. `images` are base64 `{ data, mimeType }` (PNG, JPEG, GIF, WebP) the model sees after the text. Rejects with `busy` while a turn runs |
| `waitForIdle()` | Resolves once no turn runs; use it to queue input |
| `interrupt()` | Stop the running turn. A pending permission request is denied, or a pending question cancelled, so the tool call gets a result; the model is not called again. Returns what it did |
| `respond(requestId, response)` | Answer a pending request; returns `stale` if it was already settled |
| `runCommand(name, args)` | Local commands without building strings |
| `setPermissionMode(mode)` | Switch the permission mode right away, also while a turn runs; the next tool call uses it |
| `setModel(model)` | Switch the model right away, also while a turn runs; `"default"` clears the override |
| `setThinking("on" \| "off" \| budget)`, `setEffort(level \| null)` | Extended thinking and reasoning effort for the session, right away; `thinking_changed` reports the result |
| `runShell(command)` | Run a shell command without the model, under the usual Bash permission and sandbox rules |
| `stopBackgroundAgent(agentId)` | Stop a background agent this session started |
| `getState()` | Snapshot: messages, usage and context size, model, modes, thinking, pending requests, todos, tasks, background agents |
| `getContext()` | How the next request fills the context window, see [Context breakdown](#context-breakdown) |
| `subscribe(listener)` / `events(signal?)` | Event stream, as a callback or an async iterator |
| `close()` | Abort the running turn, settle pending requests, release the session |

### Context breakdown

`getContext()` measures what the next request would carry: the system prompt the session has fixed, the tool list after ToolSearch, and the conversation. It returns the context window, `used` and `free` tokens, the conversation size and the auto-compact threshold, and `categories` in a fixed order:

| Category | Contents |
| --- | --- |
| `system` | Instructions, environment, output style, memory instructions, and the framing of the skill and sub-agent lists |
| `tools` | Built-in tool schemas, one item per tool |
| `mcp` | MCP tool schemas, one item per server |
| `skills` | Lines of the skill list |
| `plugins` | Skills, sub-agents, and MCP tools that plugins contribute, one item per plugin |
| `rules` | AGENT.md and AGENTS.md files and the memory index |
| `messages` | User messages, assistant replies, and tool results |

Each category's items add up to the category, and the categories add up to `used`. `totals` holds the four figures `/context` prints, so the two always agree. All figures are estimates from character counts (`estimated: true`).

### Events

Every event carries `sessionId` and `seq`, a per-session sequence number. A new subscriber first receives `state_snapshot` with the current state, so it never has to replay history.

| Group | Events |
| --- | --- |
| Turn lifecycle | `turn_started` (with `source`: `user`, `background`, `plan_followup`, `feedback_followup`), `turn_completed` (stop `reason`, `toolTurns`, `continuation`), `turn_failed` |
| Model output | `text_delta`, `thinking_started`, `thinking_delta`, `thinking_completed`, `redacted_thinking`, `assistant_message` |
| Tools | `tool_started`, `tool_progress` (execution status, Bash output, MCP progress, sub-agent progress), `tool_completed`, `tool_results` |
| Interaction | `request_opened`, `request_resolved` |
| Conversation | `messages_changed`, `usage_changed`, `compacted`, `token_warning`, `api_retry`, `stream_restart`, `error`, `notice` |
| Session settings | `mode_changed`, `model_changed`, `thinking_changed`, `task_mode_changed`, `todos_changed`, `tasks_changed`, `background_agents_changed`, `session_cleared`, `session_replaced` |
| Local commands | `command_progress`, `command_output`, `command_view` (session picker, diff, memory files, permission rules, plugins), `editor_requested` |

Stop reasons are `completed`, `aborted`, `model_error`, `max_turns`, and `blocking_limit`.

All events, states, and requests are plain JSON, so they can be forwarded to another process unchanged.

### Interaction requests

| Kind | Raised when | Answers |
| --- | --- | --- |
| `permission` | A tool call resolves to "ask" | `{ decision: "allow_once" \| "allow_always" \| "deny" }` |
| `plan_approval` | The model asks to leave plan mode (includes the plan text) | `{ decision: "approve", clearContext?, acceptEdits? }` or `{ decision: "reject", feedback? }` |
| `question` | The model asks multiple-choice questions | `{ answers: { [question]: label } }` or `{ cancelled: true }` |

Permission and plan-approval requests carry `toolUseId`, the id of the tool call they guard; it matches the `toolUseId` of that call's `tool_started` event.

A request is answered in one of three ways:

1. A **handler** for its kind answers automatically.
2. Otherwise, if the kind is listed in `interactions`, the request is published with `request_opened` and waits for `respond()`, `interrupt()` (which also ends the turn), the end of the turn, or `close()`.
3. Otherwise the safe default applies at once: permission and plan approval are **denied**, questions are **cancelled**.

Approving a plan with `clearContext` stops the planning turn and starts a fresh turn that implements the plan; it also allows Write, Edit, and npm/npx commands for the rest of the session unless `acceptEdits: false`. Rejecting with `feedback` starts a turn that asks the model to revise the plan.

### Transcripts

A persisted session's transcript holds the conversation exactly as the model sees it, including hidden context such as plan-mode reminders and background-agent notifications, so `resumeSession()` continues from the same context. `/clear`, compaction, and a plan implemented in a fresh context start a new segment; resume reads from the last one.

### `/resume`

A session handle's `id` never changes. When `/resume <id>` switches the conversation, the session emits `session_replaced` with the new id; `runtime.getSession(newId)` returns the handle to use from then on, and calls on the old handle reject with `replaced`. Existing subscriptions keep receiving events.

## Security

The SDK uses the same checks as the terminal:

- Settings allow and deny rules, the sandbox auto-allow gate, and the Auto Mode classifier decide before any request is raised. A deny rule cannot be overridden by `respond()` or a handler.
- Workspace trust is never assumed: an untrusted workspace ignores project settings, `.env` credentials, hooks, project MCP servers, plugin executables, and model profiles unless you pass `trust: "session"`.
- Extra file roots come from trusted settings only; the sandbox and `failClosed` behave as in the terminal.
- Background agents never raise confirmation requests.
- `runShell()` runs through the Bash tool and its sandbox.

## Errors

Errors raised by the SDK are `AgentSdkError` with a stable `code`: `busy`, `closed`, `replaced`, `permission_settings`, `session_restore`, `session_storage`, `already_open`, `runtime_active`, `not_found` (no saved session, `.mcp.json` server, or MCP server with that name), `invalid_argument` (for example a session id that is not one), `provider` (a model provider request failed), `untrusted` (the call needs project configuration an untrusted workspace ignores). Use `isAgentSdkError(error, code)` to check. A turn that fails for any other reason rejects `send()` with the original error and emits `turn_failed`.

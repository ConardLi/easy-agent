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
  harness: { name: "reviewer" }, // experimental: the Agent sessions use, or { spec }; default: the workspace's default Agent
});
```

`runtime.report` tells you whether the workspace is trusted, which project configuration an untrusted workspace ignored, how many project credential overrides were ignored, and why the sandbox is unavailable, if it is.

| Method | Purpose |
| --- | --- |
| `createSession(options?)` | Start a new conversation |
| `resumeSession(sessionId?, options?)` | Reopen a saved conversation; without an id, the most recent one |
| `listSessions(limit?)` / `readSession(id)` | Saved conversations of the workspace, without opening them. Summaries carry the first prompt the user typed and the title, if set |
| `renameSession(id, title)` | Set a saved session's title; an empty title clears it |
| `forkSession(id, { title?, fromMessage? })` | Copy a saved conversation into a new session. With `fromMessage`, a checkpoint id from `listCheckpoints()`, the copy ends just before that prompt. The copy keeps the file checkpoints of the turns it holds; the files on disk are not touched |
| `deleteSession(id)` | Delete a saved session's transcript, title, file checkpoints, and task list; close it first |
| `getSession(id)` / `listOpenSessions()` | Sessions currently open |
| `getCapabilities()` | Built-in commands, invocable skills, user commands, sub-agent types, output style; skills and sub-agent types the Agent leaves out are not listed |
| `resolveModel()` | The model a session uses when none is given |
| `startServices(options?)` | Connect MCP servers and plugin services |
| `connectMcpServers(servers)` | Connect more MCP servers, such as the ones an editor supplies; a name that is already configured keeps its server, and a server the Agent's `mcpServers` lists leave out is not started; both are returned in `skipped` |
| `hasModelCredentials(model?)` | Whether requests for the model have an API key, an auth header, or a custom endpoint |
| `readConfig()` | Settings sources, effective values with their source and reload policy, and model profiles; inline secrets come back as `[redacted]`, `${VAR}` references as written |
| `writeConfig(scope, key, value)` | Set or (with `null`) delete one key in user, project, or local settings, after validation; open sessions pick up permission rules right away |
| `setWorkspaceTrust(trusted)` | Save or revoke trust for the workspace; it applies to the next runtime |
| `checkModel(model)`, `listModels(model)` | Send a one-token request through a model handle; list the models its provider offers |
| `getInventory()` | Everything the runtime has loaded, see [Inventory](#inventory) |
| `getHarness({ name?, spec? })` / `diffHarness(a, b)` | Resolve an Agent and compare two; see [Agents](#agents). Experimental |
| `reload()` | Reload skills, commands, sub-agents, output styles, and plugins from disk. Open sessions use the new set from their next turn; returns the registry sizes, plugin MCP servers started and stopped, and plugin errors |
| `approveMcpServer(name, approved, scope?)` | Approve or reject a server from the project's `.mcp.json`. The decision is saved in `enabledMcpjsonServers` or `disabledMcpjsonServers` of `scope` (default `local`); an approved server connects right away, a rejected one stops. Rejects with `untrusted` in an untrusted workspace |
| `reconnectMcpServer(name)` | Drop a registered MCP server's connection and connect again; returns the status, the error if it failed, and the tool count |
| `listPlugins()` | Installed plugins (version, whether enabled and in which scope, components, whether their hooks and servers may run here, warnings), what the registered marketplaces offer, the marketplaces, and plugin load errors |
| `previewPlugin(pluginId)` | Fetch and validate `name@marketplace` without installing it: version, components, whether it runs local processes (hooks, MCP, LSP), warnings, errors, and a content `fingerprint` |
| `mutatePlugin(action)` | `install` and `update` (with the confirmed preview's `fingerprint` as `expectedFingerprint` and `confirmedExecutableComponents: true`), `enable`, `disable`, `uninstall` (`keepData?`) in `user`, `project`, or `local` scope, and `marketplace-add` (local path, Git URL, or `owner/repo`), `marketplace-update`, `marketplace-remove`. Registries reload right away and open sessions use the change from their next turn; returns the new `listPlugins()` view. Content that changed since the preview fails with `plugin`; the `project` and `local` scopes fail with `untrusted` in an untrusted workspace, except `uninstall` |
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

Items that occupy context carry token counts as `{ value, estimated }`: a skill's line in the skill list and its body, a sub-agent's line, an output style's prompt, a rule file, a tool's schema. Counts come from character lengths, so `estimated` is `true`. MCP servers report `status` (`connected`, `pending`, `failed`, `disabled`, `awaiting_approval`, `rejected`, or `ignored` in an untrusted workspace), their tools, and the error when connecting failed; a server the Agent's `mcpServers` lists leave out is `disabled` with the reason. Tools report whether ToolSearch defers them for the runtime's model, and a tool the Agent's `tools` lists leave out has `enabled: false` with the reason (see [Tools and MCP servers](./configuration.md#tools-and-mcp-servers)), and so do skills and sub-agents its `skills` and `agents` lists leave out (see [Skills and sub-agents](./configuration.md#skills-and-sub-agents)). Project configuration an untrusted workspace ignores still appears, disabled, with the reason.

### Agents

`createAgentRuntime({ harness })` selects the Agent this runtime's sessions use: `{ name }` from the `harnesses` key of the user settings file, or `{ spec }`, a spec object resolved over its `extends`; without it, the workspace's default Agent (see [Agent management](#agent-management)), then `default`. Every Agent setting the sessions read comes from that Agent. A selection that does not resolve (unknown name, invalid spec, broken `extends`) rejects with code `harness`; passing both `name` and `spec` rejects with `invalid_argument`. Keys the Agent sets that this version does not apply yet go to the `logger` as warnings.

`getHarness()` returns the Agent this runtime's sessions use, with the settings files as they are now and the environment variables as they were when the runtime started; `{ name }` resolves an Agent from the `harnesses` key of the user settings file, and `{ spec }` resolves a spec object over its `extends` (see [Agent specs](./configuration.md#agent-specs-harnesses)). The result has the Agent `name`, the `chain` of specs applied over the built-in default, a `hash` of all values, `issues` (unknown names, `extends` cycles, invalid specs, keys this version does not apply yet), and `values`: for each key such as `model.main` or `permissions.deny`, the `value`, the layer it came from (`source`: `built-in`, `user`, `harness`, `project`, `local`, `environment`, `flag`, `policy`) with a `detail` such as the settings key, whether this version `applied` it, every accepted `contribution`, the `ignored` values with a `reason`, and `overridesHarness` when a project or local setting replaced the Agent's value. `diffHarness(a, b)` lists the keys whose values differ.

`getHarness({ name })` and `getHarness({ spec })` resolve other Agents for comparison; they do not change what the runtime's sessions use. When the workspace's default Agent chose the runtime's Agent, the result has `selectedBy: { source: "local", path }`.

### Agent management

`eagent/sdk/experimental` creates, edits, renames, deletes, exports, and imports the Agents in `harnesses`, and sets the workspace's default Agent. These exports may change in a minor release. They work with or without a runtime, and share the module instance of `eagent/sdk`, so a change to the Agent of the runtime in the same process reloads it.

```ts
import { listHarnesses, writeHarness, setProjectHarness } from "eagent/sdk/experimental";

await writeHarness("reviewer", { description: "Reviews code", tools: { exclude: ["Write", "Edit"] } });
await setProjectHarness("reviewer", { cwd }); // runtimes started in cwd now use it
const { harnesses, projectDefault } = await listHarnesses({ cwd });
```

| Function | Purpose |
| --- | --- |
| `listHarnesses({ cwd? })` | The built-in Agents and those in `harnesses`, each with `builtIn`, `defined` (has an entry; for `default`, whether you changed it), `description`, `extends`, `dependents` (Agents that extend it), `projectDefault`, and `errors`; the workspace's `projectDefault` (`name`, `path`, `applied`, `reason`); the settings file `path` |
| `readHarness(name)` | The stored `spec` (`{}` for an unchanged built-in) with the same fields. Unknown names reject with `not_found` |
| `writeHarness(name, spec)` | Create or replace an Agent. Returns the stored `spec`, `created`, `affected`, and `reloaded` |
| `deleteHarness(name)` | Delete an Agent; `default` goes back to the built-in. An Agent others extend rejects with `harness` |
| `renameHarness(from, to, { cwd? })` | Rename an Agent; the Agents that extend it and the workspace's default Agent follow (`updatedExtends`, `updatedProjectDefault`) |
| `exportHarness(name)` | `{ format: "easy-agent-harness", version: 1, name, spec }` |
| `previewHarnessImport(data, { cwd? })` | What an export would do in the workspace, and the `fingerprint` that confirms it |
| `importHarness(data, { fingerprint, name?, replace? })` | Write an export into `harnesses` |
| `setProjectHarness(name \| null, { cwd? })` | Set the workspace's default Agent, or go back to `default` with `null` |

- **Writes.** Each change is one locked read-modify-write of the user settings file: only the `harnesses` key changes, concurrent writers (other processes too) keep each other's Agents, and the file is replaced atomically. Before writing, every Agent is resolved against the new definitions; when the change would give one an error it did not have (an invalid spec, an `extends` that names no Agent or forms a cycle, an unreadable `file`), it rejects with `harness` and the file stays as it was. Agents that were already broken do not block other writes. Specs have no credential fields, and the functions return nothing else from the file.
- **`default`.** `writeHarness("default", spec)` writes `harnesses.default` with only what differs from the built-in default and the top-level user settings; a spec without differences removes the entry, and so does `deleteHarness("default")`. It cannot extend another Agent.
- **Reloading.** `affected` lists the Agent and every Agent that extends it (for `default`, every Agent). When the runtime in this process uses one of them (its Agent or one it extends), it resolves its Agent again and reloads the permission rules of its open sessions, and `reloaded` is `true`; other runtimes pick the change up before their next model request. Servers an Agent's `mcpServers` lists choose are started at startup, so restart for those. A frontend that runs one process per Agent restarts or reloads only the processes whose Agent is in `affected`.
- **Export and import.** An export holds every value along the Agent's `extends` chain (the changes to `default` included), with `file` references replaced by their text, so it resolves the same on another machine. `previewHarnessImport` lists the built-in tools and the workspace's configured MCP servers the Agent keeps, the permission mode it runs in, the `allow`, `ask`, and `deny` rules it adds, every key it sets, and the errors that would make the import fail; show this to the user. `importHarness` needs the preview's `fingerprint` and rejects content that differs from it, an existing name without `replace`, and a spec that reads a `file` (an import carries its text inline).
- **The workspace's default Agent** is `harness` in `<cwd>/.easy-agent/settings.local.json`, which is personal and not committed. `setProjectHarness` needs a trusted workspace (`untrusted` otherwise) and an Agent that resolves. A runtime started without `harness` uses it and keeps it until it stops. When it names an Agent that no longer exists, the runtime warns and uses `default`; when that Agent does not resolve, startup rejects with `harness`. The key is ignored with a warning in an untrusted workspace and in every other settings file.

Errors carry the SDK codes `not_found`, `invalid_argument`, `harness`, and `untrusted`. RPC offers the same operations as `harness/*` methods.

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
| `listCheckpoints()` | Prompts the conversation can go back to, see [Checkpoints and rewind](#checkpoints-and-rewind) |
| `rewind({ to?, scope, dryRun? })` | Restore the files, the conversation, or both to just before a checkpoint's prompt. Rejects with `busy` while a turn runs |
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

### Checkpoints and rewind

Every prompt a person typed is a checkpoint. `listCheckpoints()` returns them oldest first, each with an `id`, the `messageIndex` of the prompt in `getState().messages`, the `prompt` as typed (a skill or command reads `/name args`), and `files`: whether a file checkpoint was taken before it. Prompts removed by `/clear` or summarized by compaction are no longer checkpoints.

`rewind({ to, scope })` goes back to just before the prompt of checkpoint `to`:

| `scope` | Effect |
| --- | --- |
| `files` | Files edited since then return to their content at that point; files created since then are deleted. The conversation stays, and the next prompt tells the model which files were restored |
| `conversation` | The prompt and everything after it leave the conversation, including hidden context the turn added before the prompt. The files stay |
| `both` | Both of the above |

Without `to`, a `files` rewind restores the files to before the first edit the session tracked. `dryRun: true` returns the same result without changing anything: the checkpoint, `messagesRemoved`, and `files` with the paths (relative to the workspace when inside it) and the lines added and removed by restoring them. Show it to the user before rewinding.

Only edits made by the Write, Edit, and MultiEdit tools of the session are tracked. Changes made by shell commands, by sub-agents, or outside the agent are not restored, and a files rewind overwrites later manual edits to the tracked files. The conversation cannot be restored once rewound; `forkSession(id, { fromMessage })` keeps the original and starts a copy instead.

A rewind emits `session_rewound` with the scope, the checkpoint id and `messageIndex`, the remaining `messages`, and the restored `files`; a conversation rewind is followed by `messages_changed` and `usage_changed`. Todos return to the last list in the remaining conversation. A persisted session writes a new transcript segment, so resume continues from the rewound conversation and its checkpoints.

A `files` rewind leaves the undone Write, Edit, and MultiEdit calls in the conversation. `SessionState.revertedToolUses` lists them, so a frontend that shows the session's changes can leave them out. The list is recorded in the transcript and survives resume and forks; calls that later leave the conversation drop out of it.

### Events

Every event carries `sessionId` and `seq`, a per-session sequence number. A new subscriber first receives `state_snapshot` with the current state, so it never has to replay history.

| Group | Events |
| --- | --- |
| Turn lifecycle | `turn_started` (with `source`: `user`, `background`, `plan_followup`, `feedback_followup`), `turn_completed` (stop `reason`, `toolTurns`, `continuation`), `turn_failed` |
| Model output | `text_delta`, `thinking_started`, `thinking_delta`, `thinking_completed`, `redacted_thinking`, `assistant_message` |
| Tools | `tool_started`, `tool_input_delta`, `tool_progress` (execution status, Bash output, MCP progress, sub-agent progress), `tool_completed`, `tool_results` |
| Interaction | `request_opened`, `request_resolved` |
| Conversation | `messages_changed`, `usage_changed`, `compacted`, `token_warning`, `api_retry`, `stream_restart`, `error`, `notice` |
| Session settings | `mode_changed`, `model_changed`, `thinking_changed`, `task_mode_changed`, `todos_changed`, `tasks_changed`, `background_agents_changed`, `session_cleared`, `session_replaced`, `session_rewound` |
| Local commands | `command_progress`, `command_output`, `command_view` (session picker, diff, memory files, permission rules, plugins), `editor_requested` |

`tool_started` arrives as soon as the model begins a tool call, before its input exists. While the model writes the input, `tool_input_delta` events carry it as JSON fragments (`partialJson`); concatenated in order, the fragments of one `toolUseId` make up the input. A frontend can parse the unfinished JSON leniently to show a path or command early. The committed input is in the `assistant_message` that follows, and tools run only after it. Calls streamed before a `stream_restart` are never committed; the restarted request streams new ones.

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

A persisted session's transcript holds the conversation exactly as the model sees it, including hidden context such as plan-mode reminders and background-agent notifications, so `resumeSession()` continues from the same context. Each message records the turn that added it, which is how checkpoints survive resume. `/clear`, compaction, a conversation rewind, and a plan implemented in a fresh context start a new segment; resume reads from the last one.

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

Errors raised by the SDK are `AgentSdkError` with a stable `code`: `busy`, `closed`, `replaced`, `permission_settings`, `session_restore`, `session_storage`, `already_open`, `runtime_active`, `not_found` (no saved session, `.mcp.json` server, or MCP server with that name), `invalid_argument` (for example a session id that is not one), `provider` (a model provider request failed), `untrusted` (the call needs project configuration an untrusted workspace ignores), `plugin` (a plugin or marketplace operation failed: not found, invalid, changed since the preview), `harness` (the Agent selected with `createAgentRuntime({ harness })` does not resolve). Use `isAgentSdkError(error, code)` to check. A turn that fails for any other reason rejects `send()` with the original error and emits `turn_failed`.

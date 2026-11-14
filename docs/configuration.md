# Configuration and feature controls

Easy Agent resolves settings from these sources, from lowest to highest priority:

1. user: `~/.easy-agent/settings.json`
2. trusted project: `<cwd>/.easy-agent/settings.json`
3. trusted local: `<cwd>/.easy-agent/settings.local.json`
4. parent-process compatibility environment (feature-specific only)
5. CLI/`--settings` flag layer
6. managed policy

Project and local settings that can execute code, redirect providers, or widen resource access are ignored until the workspace is trusted. `/config list` and `/doctor` show effective values, their source, and reload behavior. Secrets, environment values, headers, hooks, MCP definitions, and endpoint credentials are redacted.

[configuration-inventory.md](./configuration-inventory.md) lists every settings key, environment variable, and fixed behavior value, with the layers each key is read from and when each variable takes effect.

## ToolSearch

```json
{
  "toolSearch": "auto",
  "toolSearchAutoThreshold": 10
}
```

- `off`: expose every tool schema inline.
- `auto`: defer schemas when their estimated size reaches the configured percentage of the context window.
- `on`: always defer eligible tool schemas.

`--tool-search off|auto|on` overrides file settings. `EASY_AGENT_ENABLE_TOOL_SEARCH` and `ENABLE_TOOL_SEARCH` remain compatible throughout the 0.x line (`true`, `false`, `auto`, `auto:N`) and are planned for removal no earlier than 1.0 after a migration notice.

## Model roles

`modelRoles` routes specific invocation classes while preserving explicit model overrides:

```json
{
  "modelRoles": {
    "background": "fast-profile",
    "think": "reasoning-profile",
    "longContext": "long-context-profile"
  }
}
```

- `background`: asynchronous sub-agents and teammates without an explicit or agent-defined model.
- `think`: main-agent requests using extended thinking.
- `longContext`: main-agent requests whose current message history exceeds 80% of the fallback model's context window; takes precedence over `think`.

Values are model profile IDs or raw Anthropic model names. Per-call and custom-agent model declarations remain authoritative.

## Project memory files

Every session loads `~/.easy-agent/AGENT.md`, then `AGENTS.md` and `AGENT.md` from each directory between the filesystem root and the working directory, outermost first. A directory can hold both files: `AGENTS.md` loads first and `AGENT.md` after it, so Easy Agent-specific notes can extend a shared `AGENTS.md`. A project that only has `AGENT.md` loads exactly as before.

`/init` writes `AGENT.md`. If the repository root has an `AGENTS.md` and no `AGENT.md`, `/init` improves `AGENTS.md` instead of creating a second file. `/memory` lists the files that exist, plus the project `AGENT.md` when the working directory has neither file.

`claudeMdExcludes` matches absolute paths, so each name needs its own pattern:

```json
{
  "claudeMdExcludes": ["**/AGENTS.md", "/abs/path/to/repo/AGENT.md"]
}
```

## Prompt caching

Providers reuse a cached request prefix only while it stays byte-identical. Easy Agent keeps the prefix stable for the whole session and tells each provider where it ends.

**The system prompt is written once per session.** The environment section holds the date (day precision) and a git snapshot labelled as taken at session start. When AGENTS.md or AGENT.md, the memory index, the response language, the output style, the available skills or agents, or the date change later, the next user message is preceded by a hidden context update that lists only the changed sections. The system prompt is rebuilt from the current state after `/clear`, after compaction, when a session is resumed, and when an output style drops the base coding instructions. Run `git status` (the agent does this itself when it needs to) for the current repository state.

**Anthropic** requests carry four `cache_control` markers: the end of the static system block, the end of the dynamic system block, the last message of the previous request, and the last message. A system prompt without the static/dynamic split gives its spare marker to the last loaded tool. The Auto Mode classifier caches its fixed prompt and tool; other single-shot calls are sent uncached.

**OpenAI** caches matching prefixes automatically. Requests to `api.openai.com` also send the session id as `prompt_cache_key`, which routes requests with the same prefix to the same cache. For an OpenAI-compatible endpoint that documents `prompt_cache_key`, enable it on the profile:

```json
{
  "models": {
    "gateway": {
      "protocol": "openai-chat",
      "model": "gpt-5.5",
      "baseURL": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_API_KEY}",
      "promptCacheKey": true
    }
  }
}
```

`"promptCacheKey": false` turns it off for an `api.openai.com` profile.

**Gemini** applies implicit caching on its own; nothing extra is sent.

`/cost` and `/status` show cache read and write tokens and the cached share of input once the provider reports cache activity. OpenAI `cached_tokens` and Gemini `cachedContentTokenCount` are reported as cache reads, and input tokens then count only the uncached part, the same as on Anthropic. Headless JSON `usage` follows the same rule.

Set `EASY_AGENT_DISABLE_PROMPT_CACHING=1` for an endpoint that rejects `cache_control` or `prompt_cache_key`. Requests then go out without cache fields; the session-stable system prompt is unaffected.

## Forked Skills

A Skill with `context: fork` executes in a fresh sub-agent context. It inherits the active permission infrastructure but not the parent message history. Its `allowed-tools` narrows the available tool pool and supplies only session-scoped allow rules for the fork. Optional `agent` and `model` frontmatter select an agent definition or model; defaults are `general-purpose` and the active model. Nested forks are rejected.

## Plugin LSP servers

Plugins may declare inline `lspServers` or point `lspServers` at JSON files inside the plugin root. `.lsp.json` is also discovered automatically.

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescriptreact" },
      "transport": "stdio",
      "startupTimeout": 10000,
      "requestTimeout": 10000,
      "restartOnCrash": true,
      "maxRestarts": 2
    }
  }
}
```

LSP processes are executable plugin components: they start only for trusted plugins. Paths cannot escape the plugin root; commands are spawned without a shell; JSON-RPC frames, queues, requests, document size, timeouts, cancellation, restarts, and process-tree cleanup are bounded. The `LSP` tool exposes read-only `definition`, `references`, `hover`, and `documentSymbol` requests. Failed replacements retain the previously ready server.

## Tool turn limit

One request stops after a fixed number of model calls that end in tool use. The default is 200 in the interactive REPL and 50 for Headless runs (`-p`).

```json
{
  "maxTurns": 400
}
```

`--max-turns <n>` overrides the setting for one invocation, and managed policy overrides both. The value must be a positive integer; anything else is ignored. The limit applies to the main session only: sub-agents keep the `maxTurns` from their own definition.

When the REPL reaches the limit, the conversation so far is kept. Send another message, for example `continue`, to resume. Headless runs end with `error_max_turns` and exit code 1, as before.

## Agent specs (`harnesses`)

`eagent harness list` lists the Agents, which ones do not resolve and why, and this workspace's default Agent; `--json` prints the same data. `eagent harness show [name|file]` prints every setting an Agent resolves to, where each value comes from, values a layer set but could not apply, and the built-in tools, prompt sections, and context sources with their ids; `--json` prints the same data. `eagent harness diff <a> <b>` compares two Agents key by key; with `--prompt <text>` it also renders the first request a new session of each Agent would send for that text and lists, component by component, which prompt sections, context sources, tools, and messages one has and the other does not, the lines that changed, and the token difference of each (estimated from the text). Rendering calls no model, runs no tool or hook, and saves nothing; it starts a runtime with `<a>`'s Agent, connecting its MCP servers as a session would, so MCP tools are those servers'. An argument with a path separator or a `.json` suffix is read as a spec file. In a session, `/harness [show] [name|file]`, `/harness diff <a> <b>`, and `/harness list` show the same views, and `/harness use <name>` sets this workspace's default Agent (see below). Programs create, edit, rename, delete, export, and import Agents through the [SDK](./sdk.md#agent-management) or the `harness/*` [RPC methods](./rpc.md#methods); those writes validate every Agent before they change the file.

An Agent is a Harness spec: the model, tools, prompt, context sources, compaction, permissions, skills, sub-agents, commands, output style, MCP servers, plugins, and feature switches it uses. User-defined Agents live only in the user settings file; `harnesses` in project, local, flag, or policy settings is ignored with a warning, and the SDK and RPC refuse to write it to a project or local file.

```json
{
  "harnesses": {
    "default": { "outputStyle": "Explanatory" },
    "reviewer": {
      "extends": "default",
      "model": { "main": "sonnet" },
      "prompt": { "identity": { "file": "prompts/reviewer.md" } },
      "permissions": { "deny": ["Write", "Edit", "Bash"] }
    }
  }
}
```

- `extends` names a built-in Agent (`default`) or another one in `harnesses`; it defaults to `default`. Objects merge with their parent, and lists and plain values replace it. Cycles and unknown names are errors.
- `harnesses.default` overrides the built-in default and extends nothing else, so it only records what you changed. Editing it through the SDK or RPC drops values the built-in default and the top-level user settings already give; deleting it restores the built-in default.
- Text fields accept a string, `{ "text": "…" }`, or `{ "file": "…" }`. Relative paths resolve against `~/.easy-agent/`, and `~/` against the home directory.
- Unknown keys are errors, so a typo is reported instead of ignored.

### Tools and MCP servers

`tools.include` and `tools.exclude` choose the built-in and MCP tools the Agent uses, `tools.config` sets single tools, and `mcpServers.include` and `mcpServers.exclude` choose which configured MCP servers it starts.

```json
{
  "harnesses": {
    "reviewer": {
      "tools": {
        "exclude": ["Write", "Edit", "MultiEdit", "PowerShell", "mcp__github__create_*"],
        "config": { "Bash": { "timeoutMs": 300000, "maxOutputBytes": 60000 }, "Read": { "maxResultChars": 50000 } }
      },
      "mcpServers": { "include": ["github", "plugin:docs:*"] }
    }
  }
}
```

- An entry is a tool or server name, or a pattern where `*` matches any characters. MCP tools are named `mcp__<server>__<tool>`; a plugin's servers are named `plugin:<plugin>:<server>`. Names are case-sensitive.
- Without `include` everything is kept; with it, only matching names, and `"include": []` keeps nothing. `exclude` is applied after `include` and wins over it.
- A tool the Agent leaves out is not sent to the model, not listed for ToolSearch, and refused if the model calls it anyway. Sub-agents, forked skills, and teammates start from the same tools, so a sub-agent definition that lists the tool does not get it back, and neither does an `allow` rule.
- `include` applies to ToolSearch and the plan mode tools too: an `include` without `ToolSearch` sends the kept tools' schemas directly, and one without `EnterPlanMode`/`ExitPlanMode` leaves the model without them (`/mode plan` and `/mode default` still switch).
- A server the Agent leaves out is not started: servers from settings and `.mcp.json`, plugin servers, servers an editor passes over ACP, and ones added with `runtime.connectMcpServers()` (reported as skipped). `.mcp.json` approval still applies to the servers the Agent keeps.
- The lists come only from the Agent's spec, so project and local settings cannot add a tool or server back. As with other lists, a child's list replaces its parent's along `extends`.
- `/harness`, `eagent harness show`, and `runtime/inventory` show left-out tools as off and left-out servers with status `disabled`, each with the list and Agent that turned it off. Names in the tool lists that match no built-in tool are printed as a warning when the runtime starts (MCP tool names are not checked, since servers connect later).
- `tools.config` is keyed by exact tool name. `timeoutMs` is the timeout of a Bash or PowerShell command whose call sets none (built-in 120000; the tool's description tells the model the value, and a timeout the call passes still wins), `maxOutputBytes` the command output kept for the model (built-in 30000), and `maxResultChars` the characters of any tool's result before it is truncated (built-in 100000 unless the tool sets its own). A name that matches no built-in tool, or `timeoutMs`/`maxOutputBytes` on another tool, is printed as a warning when the runtime starts; an invalid value is a spec error. A child's `tools.config` replaces its parent's as a whole.
- Tool lists and tool settings apply from the next model request after an edit; server lists apply when servers start, so restart after changing them.

### Prompt and context sources

`prompt.identity` replaces the identity text, `prompt.sections` turns the dynamic sections off, replaces their text, moves them, or adds new ones, and `context` chooses which sources the built-in sections load.

```json
{
  "harnesses": {
    "reviewer": {
      "prompt": {
        "identity": { "file": "prompts/reviewer.md" },
        "sections": {
          "memory": false,
          "review-rules": { "file": "prompts/review-rules.md", "after": "agent_md" },
          "language": { "after": "instructions" }
        }
      },
      "context": { "gitStatus": false, "skills": false }
    }
  }
}
```

- The system prompt has a static block (`identity`, then `instructions`, the coding instructions) and a dynamic block with the sections `output_style`, `language`, `environment`, `agent_md`, `memory`, `session_instructions`, `skills`, `agents`, and `team`, in that order. `eagent harness show` lists them as `prompt_section:<name>`.
- `prompt.identity` takes the text forms above and replaces the two built-in identity paragraphs; an empty string leaves the identity out. The coding instructions stay unless an output style sets `keepCodingInstructions: false`.
- A `prompt.sections` entry is `false` (leave the section out), `true` (keep it), or an object. In an object, `text` or `file` (not both) replaces a built-in section's text, or adds a section under a new name; `after` names the section it follows, and `"after": "instructions"` puts it first in the dynamic block. An added section without `after` goes last, and several sections after the same one keep the built-in order, then the order in the spec. `identity` and `instructions` cannot be listed here.
- A name that is neither a built-in section nor an added one, an `after` that names no section or the section itself, and `after` entries that form a cycle are printed as warnings when the runtime starts; those sections keep their own place.
- `context.agentMd`, `context.memory`, `context.environment`, `context.gitStatus`, `context.skills`, and `context.agents` (all `true` by default) turn off one source each: the AGENTS.md and AGENT.md files, the memory index (the memory instructions stay; turn the `memory` section off to drop both), the working directory, date, and operating system, the git branch, status, and latest commit, the skill listing, and the sub-agent listing. A section the Agent turns off or replaces does not read its source.
- `/context` and `runtime/inventory` leave out rule files and the memory index the Agent does not load, and the inventory gives the reason. `/harness` shows each section and source as on or off with the reason, and which text replaces a section.
- The session builds its system prompt once and keeps it so the provider can cache it. A change to a dynamic section (an edit to the Agent, or to AGENTS.md or the memory index) reaches the model from the next turn as a context update at the end of the conversation, and the prompt itself stays. A change to `prompt.identity` rebuilds the prompt, so the next request writes the prompt cache again. A section whose text changes every turn would add an update every turn; text from `file` is read when the Agent is resolved, so edit the file and the next turn picks it up.
- `--dump-system-prompt --harness <name|file>` prints the prompt an Agent sends.
- A child's `prompt.sections` replaces its parent's as a whole, as `tools.config` does.

### Compaction

```json
{
  "harnesses": {
    "long-runs": { "compaction": { "autoThreshold": 0.6, "keepRecentMessages": 12 } },
    "manual": { "compaction": { "auto": false, "microcompact": false } }
  }
}
```

- `compaction.auto` (default `true`) summarizes the conversation without being asked: before a turn once it reaches the threshold, and once after the model rejects a request as too long. With `false` neither happens; a request that is too long ends the turn with the error, and `/compact` still summarizes when you run it. `/context` then warns that the Agent does not compact automatically.
- `compaction.autoThreshold` is the share of the effective window (the context window minus the room kept for the summary) at which auto-compaction starts, between 0 (exclusive) and 1. Unset starts it 13000 tokens below the effective window (scaled down for windows under 200000), as before. A value past the point where requests are refused is lowered to that point. `runtime/inventory`'s context breakdown and `/context` report the same threshold.
- `compaction.microcompact` (default `true`) clears old tool results of Read, Grep, Glob, Bash, Edit, and Write, and old images, before each turn once the conversation has 10 messages. With `false` the conversation keeps them until it is summarized.
- `compaction.keepRecentMessages` (default 8) is how many recent messages compaction keeps as they are: clearing leaves their tool results, and a summary keeps them verbatim after it (more when a kept tool result needs its call).
- `compaction.contextWindow` sets the window size, as `EASY_AGENT_MAX_CONTEXT_TOKENS` does; the variable wins over the spec.
- The settings apply from the next turn after an edit.

### Feature switches

Each switch under `features` (and `session.checkpoints`) is also controlled by the setting or environment variable it had before; those keep working and resolve as layers around the Agent's spec. The spec sits above user settings and below project and local settings, environment variables, flags, and managed policy, except where the table says the variable wins over every settings layer.

| Key | Default | Same as | Order against the spec |
|---|---|---|---|
| `features.agentTeams` | `false` | `EASY_AGENT_TEAMS`, `--agent-teams` | the variable and the flag can turn it on over the spec |
| `features.tasks` | `"task"` | `/tasks task\|todo` in a session | the session's `/tasks` changes it for that session |
| `features.toolSearch`, `features.toolSearchAutoThreshold` | `"on"`, `10` | `toolSearch`, `toolSearchAutoThreshold`, `--tool-search`, `EASY_AGENT_ENABLE_TOOL_SEARCH` (deprecated) | project and local settings, the variable, and the flag win |
| `features.thinking` | `true` | `alwaysThinkingEnabled`, `MAX_THINKING_TOKENS` | `MAX_THINKING_TOKENS` wins over every layer |
| `features.thinkingBudget` | unset | `MAX_THINKING_TOKENS=N` | the variable wins over every layer |
| `features.thinkingInRequests` | `true` | `CLAUDE_CODE_DISABLE_THINKING` | the variable wins over every layer |
| `features.adaptiveThinking` | `true` | `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | the variable wins over every layer |
| `features.interleavedThinking` | `true` | `DISABLE_INTERLEAVED_THINKING` | the variable wins over every layer |
| `features.effort` | unset | `effortLevel` | project and local settings win |
| `features.effortForAllModels` | `false` | `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | the variable wins over every layer |
| `features.promptCaching` | `true` | `EASY_AGENT_DISABLE_PROMPT_CACHING` | the variable wins over every layer |
| `features.experimentalBetas` | `true` | `EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS` | the variable wins over every layer |
| `features.maxRetries` | `10` | `EASY_AGENT_MAX_RETRIES` | the variable wins |
| `features.maxTurns` | unset | `maxTurns`, `--max-turns` | project and local settings and the flag win |
| `features.autoModeClassifier` | `true` | none | |
| `session.checkpoints` | `true` | `checkpointingEnabled`, `EASY_AGENT_DISABLE_CHECKPOINTING` | the variable wins over every layer |

- `features.tasks` is the task tracking a session starts with: `"task"`, the persistent task list (TaskCreate, TaskList, TaskGet, TaskUpdate), or `"todo"`, the session-only list (TodoWrite). `/tasks` marks the Agent's choice as the default.
- `features.autoModeClassifier: false` keeps Auto Mode from calling the classifier. Deny rules, the blocked shell commands, read-only tools and commands, and `allow` rules decide as before, and an action none of them decides asks you instead of the classifier.
- `eagent harness show` lists each switch with the layer its value came from.

### Skills and sub-agents

`skills.include` and `skills.exclude` choose the skills the Agent uses, and `agents.include` and `agents.exclude` the sub-agents it can start. They apply to built-in sub-agents and to skills and sub-agents from the user and project directories and from plugins.

```json
{
  "harnesses": {
    "reviewer": {
      "skills": { "exclude": ["deploy", "docs:*"] },
      "agents": { "include": ["Explore", "code-reviewer"] }
    }
  }
}
```

- Entries match names exactly or by `*` patterns, with the rules of the tool lists above. A plugin's skills and sub-agents are named `<plugin>:<name>`.
- A skill the Agent leaves out is not listed to the model, not activated by a matching file, and refused when the model calls it with the Skill tool or you type `/<name>`; the message names the list that left it out. A sub-agent it leaves out is not listed, and the Agent tool refuses it, including the default `general-purpose` when the call names no type and a forked skill's agent.
- The lists come only from the Agent's spec. A project skill or sub-agent with a left-out name stays out.
- `/skills` and `/agents` list the kept ones and name the ones left out, `/harness` lists them with the reason, and `runtime/inventory` returns them with `enabled: false` and the reason. `getCapabilities()` returns only the kept ones. Names that match no loaded skill or sub-agent are printed as a warning when the runtime starts.
- The lists apply from the next turn after an edit; the listing change reaches the model as a context update.

### Request records

Every model request leaves a record: the main loop, sub-agents, the Auto Mode classifier, WebFetch and WebSearch, and compaction. `trace.level` decides whether records are written to disk:

- `summary` (default) appends them to `<session-id>.trace.ndjson`, next to the session's transcript in `~/.easy-agent/projects/<project>/`. The file has the transcript's permissions (owner only), is never uploaded, follows `cleanupPeriodDays` (a file older than the period is removed at startup, and `0` removes every file and writes none), and goes away with `deleteSession()`. A session that keeps no transcript (Headless, `persist: false`) writes none either.
- `off` writes nothing. The latest record of each session stays in memory either way.
- `full` is accepted but not available yet: it warns and records at `summary` level.

```json
{ "harnesses": { "default": { "trace": { "level": "off" } } } }
```

A record never holds text from the request. It lists each part of what was sent, measured after prompt-cache markers are placed: the system prompt by section (`prompt_section:identity`, `prompt_section:environment`, a sub-agent's prompt as `agent:<source>:<type>`), with each loaded rule file (`rule:<path>`), the memory index (`rule:memory`), and each line of the skill and sub-agent lists (`skill:<source>:<name>`, `agent:<source>:<name>`) as parts of their own; each tool schema (`tool:<name>`); and each message with its source (`user_input`, `assistant`, `tool_result`, `plan_attachment`, `background_notification`, `context_update`, `hook_output`, `compaction_summary`, ...). A message that holds more than one source has `parts`: the deferred tool list ToolSearch puts in front of the first message, and the context a UserPromptSubmit hook puts before the prompt, are split from the rest. For the Anthropic protocol `bodyBytes` is the size of the body sent and `envelopeBytes` the part of it outside the system prompt, tools, and messages, so every byte is accounted for. `/context` and `session/context` read the latest main-loop record (see [Context breakdown](./sdk.md#context-breakdown)). Each part has its size in UTF-8 bytes, an estimated token count, and the first 16 hex digits of its SHA-256. The record adds the purpose, the request it was made for (a sub-agent's or the classifier's parent), the session and turn ids (the turn id is the `messageId` of the turn's transcript messages), the model, the request parameters (max tokens, thinking, effort, beta headers, tool choice, ToolSearch, prompt caching and its markers), and the outcome: stop reason, the usage the provider reported, duration, time to the first event, attempts, and retries. For OpenAI and Gemini profiles the parts are measured on the request before it is translated, and `wireBytes` gives the size of the body actually sent. Retries the Anthropic SDK makes inside one attempt are not counted.

Main-loop requests are also counted by the provider when it can: Anthropic-protocol requests to `api.anthropic.com`, or to a profile with `"countTokens": true`. Beside each request, Easy Agent asks the token-counting endpoint (`/v1/messages/count_tokens`) for the request as sent, and for the system prompt and the tool list against a one-message probe; those two counts are kept while the system prompt and tools stay the same, so a session mostly makes one counting call per request. The record's `tokenCount` then holds the provider's input tokens for the system prompt, the tools, and the messages, which add up to its `total` for the request: whatever the tools add besides their schemas counts with the tools, and the request's own framing with the messages. Counting never delays or fails a request. An endpoint that rejects it (most compatible gateways answer 404) has `tokenCount: { "status": "unsupported" }` and is not asked again for that model until Easy Agent restarts; a count that fails otherwise has `"failed"` and the next request is counted again. Requests of other purposes, OpenAI and Gemini profiles, and an Agent with `trace.level` `off` are not counted, and their records have no `tokenCount`. Counting is free on the Anthropic API but has its own rate limit; turn it off for a profile with `"countTokens": false`:

```json
{
  "models": {
    "sonnet": { "protocol": "anthropic", "model": "claude-sonnet-4-6", "countTokens": false },
    "gateway": {
      "protocol": "anthropic",
      "model": "claude-sonnet-4-6",
      "baseURL": "https://gateway.example",
      "apiKey": "${GATEWAY_API_KEY}",
      "countTokens": true
    }
  }
}
```

The file is JSON lines. A `trace_meta` line starts it; `segments` lines give the sections of a system prompt or the tools of a tool list once, under the hash a request names; each `request` line is one finished request, whose `messages.segments` lists only the messages that differ from the previous request of the same main loop or sub-agent, with `messages.reused` naming that request and how many leading messages are the same. A request whose count settled after the request line was written gets a `token_count` line with its `requestId`. The name does not end in `.jsonl`, so earlier versions, which read every `*.jsonl` there as a transcript, leave it alone.

`--harness <name|file>` selects the Agent for one run: a name from `harnesses`, or a spec file (an argument with a path separator or a `.json` suffix) that is used for that run only and never written to the settings. It works for the terminal UI, Headless (`-p`), `--dump-system-prompt`, RPC (as the default for `initialize`), and ACP. The SDK takes `createAgentRuntime({ harness: { name } })` or `{ spec }`, and RPC `initialize` takes the same `harness` parameter. Headless `result` messages name the Agent a run used and the hash of its settings in `harness` (see [Headless output](./headless-output.md#result-message)).

Without a selection the runtime uses the workspace's default Agent: `harness` in `.easy-agent/settings.local.json`, a name from `harnesses`. It is a personal choice, so it lives only in the local file, which is not committed; `/harness use <name>`, `setProjectHarness()`, and RPC `harness/setProjectDefault` write it, and `/harness use default` removes it. It applies only in a trusted workspace, and `harness` in the user, project, flag, or policy settings is ignored with a warning, so a repository cannot pick an Agent for you. A runtime binds the Agent when it starts, so a change applies to the next one. A name that no Agent has any more is reported and the runtime uses `default`; an Agent that does not resolve stops the startup as a selected one does. Without the key the runtime uses `default`, as before.

```json
{ "harness": "reviewer" }
```

A session remembers the Agent it ran with. `eagent --resume [id]` without `--harness` reopens it with that Agent, ahead of the workspace's default Agent; a session saved before Agents were recorded reopens with `default`. When that Agent no longer exists, the session continues with `default` and a warning. The resume notice says when the Agent's settings changed since the session last ran, and lists them, or when another Agent runs it (`--harness` picked one, or `/resume` switched to it inside a session that runs another Agent). From then on the session remembers the Agent it now runs with. A fork keeps the Agent of the session it copies.

A selected Agent must resolve: an unknown name, an invalid spec, a broken `extends` chain, or an unreadable `file` reference stops the startup with the reason (exit code 1, SDK error code `harness`) instead of running another Agent. Keys the Agent sets that this version does not apply yet are printed as warnings when the runtime starts. If the definition stops resolving while the runtime runs (it was edited or removed), the runtime keeps the Agent's last good settings and warns once. A spec file or spec object is trusted like `--settings`: it can set permission `mode` and `allow` rules, because whoever starts Easy Agent chose it.

A value resolves through these layers, lowest first: the built-in default, top-level keys in user settings, the Agent's spec, project settings, local settings, environment variables, CLI flags, and managed policy. Project and local settings follow the same trust rules as today: in an untrusted workspace they can only add deny rules and other restrictions, and permission `mode` comes only from user settings, flags, and policy. Some environment variables keep their existing precedence: `ANTHROPIC_MODEL` acts as the default model, and `MAX_THINKING_TOKENS`, `EASY_AGENT_DISABLE_CHECKPOINTING`, and the thinking, caching, and beta switches override every settings layer. The resolved snapshot records, for each value, the layer it came from and any values a layer set but could not apply. Spec keys that no code reads yet, such as `commands.exclude`, are reported when set.

A runtime resolves its Agent (`default` unless one is selected) when it starts, after the workspace environment is loaded, and every Agent setting in the table above is read from the resolved Agent: models and model roles, ToolSearch, `respectGitignore`, `language`, `outputStyle`, `maxTurns`, checkpoints, permission rules and mode, thinking, effort, retries, prompt caching, experimental betas, the context window, the skill listing budget, the WebSearch backend, Agent Teams, the tools and MCP servers it keeps, its prompt sections and context sources, compaction, the task mode, the Auto Mode classifier switch, the skills and sub-agents it keeps, and its request record level. Environment variables and flags are taken when the runtime starts, so change them and restart; [configuration-inventory.md](./configuration-inventory.md) marks each environment variable read this way as `runtime`.

Settings files can change while the runtime runs. Before each model request the runtime resolves the Agent again, and everything that request reads (thinking, effort, ToolSearch, model roles, `respectGitignore`) comes from that one snapshot, so an edit applies from the next request. Reads outside a request use the files as they are at that moment: a session reads `model`, `defaultModel`, `mode`, and `checkpointingEnabled` when it opens, a turn reads `maxTurns` and `language` when it starts, and permission rules are read when a session opens and after `/config` or `/permissions` change them. A request that names no model uses the Agent's main model. A sub-agent working in another directory, such as a worktree, resolves the same Agent with that directory's settings files. `/harness` without an argument shows the Agent the session runs. `/config list` shows when each setting takes effect.

## Reload behavior

ToolSearch, model roles, hooks, and most request-time settings refresh on the next relevant operation. Settings files publish one complete source snapshot at a time. If a previously valid file becomes unreadable or invalid during a live update, Easy Agent reports the problem and retains that source's last valid snapshot until the file is corrected.

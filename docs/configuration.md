# Configuration and feature controls

Easy Agent resolves settings from these sources, from lowest to highest priority:

1. user: `~/.easy-agent/settings.json`
2. trusted project: `<cwd>/.easy-agent/settings.json`
3. trusted local: `<cwd>/.easy-agent/settings.local.json`
4. parent-process compatibility environment (feature-specific only)
5. CLI/`--settings` flag layer
6. managed policy

Project and local settings that can execute code, redirect providers, or widen resource access are ignored until the workspace is trusted. `/config list` and `/doctor` show effective values, their source, and reload behavior. Secrets, environment values, headers, hooks, MCP definitions, and endpoint credentials are redacted.

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

## Reload behavior

ToolSearch, model roles, hooks, and most request-time settings refresh on the next relevant operation. Settings files publish one complete source snapshot at a time. If a previously valid file becomes unreadable or invalid during a live update, Easy Agent reports the problem and retains that source's last valid snapshot until the file is corrected.

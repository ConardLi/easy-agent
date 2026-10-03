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

## Prompt caching

Requests that use the Anthropic protocol mark the tool definitions, the static part of the system prompt, and the latest messages for prompt caching. Later requests in the same tool loop read the shared prefix from cache, which cuts input cost and time to first token on long sessions. OpenAI-compatible and Gemini requests are not changed.

`/cost` and `/status` show cache read and write tokens and the cached share of input once the provider reports cache activity.

Set `EASY_AGENT_DISABLE_PROMPT_CACHING=1` for an Anthropic-compatible endpoint that rejects `cache_control`. Requests then go out in the uncached shape.

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

## Reload behavior

ToolSearch, model roles, hooks, and most request-time settings refresh on the next relevant operation. Settings files publish one complete source snapshot at a time. If a previously valid file becomes unreadable or invalid during a live update, Easy Agent reports the problem and retains that source's last valid snapshot until the file is corrected.

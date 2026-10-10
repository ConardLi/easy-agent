# Changelog

All notable changes to Easy Agent are documented in this file.

## [Unreleased]

### Added

- `dist/THIRD_PARTY_LICENSES.txt` with the license text of every third-party package inlined into the bundle. The build fails on a license outside the allowlist.
- The release gate scans the bundled application code with the source hygiene rules, scans the packed tarball for credentials and stray files, and starts the installed CLI in Headless and interactive mode.
- README sections on use cases, supported platforms, the security model, configuration precedence, and data locations.
- Prompt caching for Anthropic requests: tool definitions, the static system prompt, and the latest messages are marked for caching. `/cost` and `/status` report cache reads, writes, and the cached share of input. `EASY_AGENT_DISABLE_PROMPT_CACHING=1` turns it off for endpoints that reject `cache_control`.
- OpenAI `cached_tokens` and Gemini `cachedContentTokenCount` are reported as cache reads in `/cost`, `/status`, and Headless `usage`. Requests to `api.openai.com` send the session id as `prompt_cache_key`; the `promptCacheKey` profile field turns it on or off for other endpoints.
- The Auto Mode classifier caches its fixed prompt and tool on Anthropic.
- Project memory also loads `AGENTS.md`. In a directory that has both files, `AGENTS.md` loads before `AGENT.md`; projects with only `AGENT.md` get the same system prompt as before. `/memory` lists existing `AGENTS.md` files, `/init` improves an existing `AGENTS.md` instead of adding `AGENT.md` next to it, and the sandbox denies writes to the project `AGENTS.md` as it does for `AGENT.md`.
- Session SDK at `eagent/sdk`: `createAgentRuntime()` bootstraps a workspace and opens sessions; `AgentSession` runs turns and publishes JSON events, permission, plan-approval, and question requests answered with `respond()` or handlers, state snapshots, and `/resume` handles. Several sessions can run in one process with separate conversation state. The terminal UI and Headless mode run on it. See `docs/sdk.md`.
- RPC mode: `eagent --rpc` serves the session SDK as JSON-RPC 2.0 over stdio for editors, desktop apps, and other languages. Version negotiation on `initialize`, the workspace trust mode chosen by the client, session events as notifications, permission, plan-approval, and question requests answered with `session/respond`, concurrent requests, and saved-session management. The protocol is documented in `docs/rpc.md` with a generated JSON Schema (`docs/rpc-protocol.schema.json`) and a minimal client in `examples/rpc-client.mjs`.
- Saved sessions can be renamed, forked, and deleted through the SDK (`renameSession`, `forkSession`, `deleteSession`) and RPC. A title is stored next to the transcript, so earlier versions still read the session, and the `/resume` picker shows it in place of the first prompt.
- Permission and plan-approval requests carry `toolUseId`, the tool call they guard.
- ACP mode: `eagent --acp` runs Easy Agent as an Agent Client Protocol v1 agent for Zed, JetBrains IDEs, and other ACP editors. Sessions can be created, loaded with replay, resumed, listed, closed, and deleted; prompts accept text, images, and embedded files; tool calls carry titles, kinds, file locations, and diffs; permission requests, plan approval, and questions (as form elicitations) go to the editor; permission modes are session modes; MCP servers configured in the editor are connected. It passes the ACP Test Compatibility Kit v1 suite. See `docs/acp.md`.
- `eagent --login` saves a model API key, base URL, and model in the user settings. ACP editors offer it as terminal login when no credentials are configured.
- `npm run acp:registry-entry` writes the ACP Registry entry (`agent.json`, `icon.svg`) for the current version.
- RPC: `session/setPermissionMode`, `session/setModel`, `session/setThinking`, `session/setEffort`, and `session/stopBackgroundAgent`.
- SDK and RPC: read and write settings (`readConfig()`/`config/read`, `writeConfig()`/`config/write`), save or revoke workspace trust (`setWorkspaceTrust()`/`workspace/trust`), and check a model connection or list a provider's models (`checkModel()`/`models/check`, `listModels()`/`models/list`). Inline secrets are never returned.
- SDK: `send()` takes images, `AgentRuntime.connectMcpServers()` adds MCP servers at runtime, and `AgentRuntime.hasModelCredentials()` reports whether the model has credentials. RPC `session/send` accepts `images`.
- SDK and RPC: a runtime inventory (`getInventory()`/`runtime/inventory`) lists skills, commands, sub-agents, output styles, MCP servers, plugins, hooks, rule files, and tools with their source, file, state, the reason when one is off, and estimated token counts. Project configuration an untrusted workspace ignores is listed as disabled.
- SDK and RPC: `reload()`/`runtime/reload` reloads skills, commands, sub-agents, output styles, and plugins without a session; open sessions use them from their next turn.
- SDK and RPC: approve or reject a `.mcp.json` server (`approveMcpServer()`/`mcp/approve`), which saves the decision and connects or stops the server right away, and reconnect a server (`reconnectMcpServer()`/`mcp/reconnect`). New SDK error code `untrusted`.
- SDK and RPC: `AgentSession.getContext()`/`session/context` splits the context window into system prompt, built-in tools, MCP tools, skills, plugins, rules, and messages, with items per tool, server, plugin, and file. The totals are the ones `/context` prints.

### Changed

- `/context` measures the system prompt the session has fixed for its requests instead of building a fresh one, so its figures match what the model receives.
- SDK: `AgentSession.setPermissionMode()` switches the mode right away, also while a turn runs, and returns nothing; it ran `/mode` as a turn.
- SDK: `AgentSession.setModel()` switches the model right away, also while a turn runs, and returns nothing; it ran `/model` as a turn. New `setThinking()` and `setEffort()` do the same for extended thinking and reasoning effort, and a `thinking_changed` event reports them, also when `/think` or `/effort` runs.
- The npm description and keywords describe product capabilities.
- The development milestone table moved from the README to `docs/learning-path.md`.
- The system prompt is written once per session so later turns reuse the provider prompt cache. The date has day precision and git status is a session-start snapshot. Changes to AGENT.md, memory, language, output style, skills, agents, or the date reach the model as a hidden context update before the next message. `/clear`, compaction, and resume rebuild the prompt. Anthropic markers now cover both system blocks, so a full conversation is read from cache on the next user message.
- The tool-turn limit per request is configurable with `--max-turns <n>` or the `maxTurns` setting. The interactive REPL default rises from 50 to 200, and reaching the limit explains how to continue. Headless runs keep the 50-turn default and the `error_max_turns` result.
- `eagent --help` and `/help` render the same command list. `--help` gains the 17 commands it was missing, `/help` gains `/think`, `/effort`, `/plugin`, `/reload-plugins`, `/hooks`, and `/rewind`, and both name the command aliases. `/compact` and `/exit` no longer appear after the settings keys in `--help`.
- `npm test` runs the offline test groups. Biome lints and formats the code; `verify:production` runs `npm run lint` and `npm run format:check`, and `npm run format` rewrites files.
- `verify:release` also runs the host sandbox tests. The release workflow runs the gate on macOS and Ubuntu and the core tests on Windows before publishing, and publishes the verified artifact without rebuilding it.
- Conversation state that was process-wide (file checkpoints, the plan file, background notifications, `/think` and `/effort`, task mode, compaction and Auto Mode counters, live tool progress) now belongs to each session. Background agents and an Agent Team belong to the session that started them.
- `verify:production` checks that the terminal UI and the entry points reach session internals only through the SDK (`npm run check:frontend-boundaries`).
- The interactive footer shows the permission mode from settings at startup; it showed `default` until the first mode change.

### Fixed

- Interrupting while the model is responding ends the turn as interrupted; it was reported as a model error, `Request was aborted.` An interrupt that arrives while a turn is still being prepared (hooks, checkpoints, context) now stops it before the model is called; it was lost.
- A session's label in `/resume` and `listSessions()` is the first prompt the user typed again. Since transcripts record hidden context, the label could show a plan-mode reminder or a background notification instead.
- Session transcripts record the conversation the model saw, including plan-mode reminders, background-agent notifications, context updates, and hook context, so a resumed session continues from the same context. A turn started by a background result now has its notification in the transcript.
- `/clear` and approving a plan with a context clear are recorded; resume starts from the cleared conversation instead of reloading the earlier messages. Transcripts stay readable by earlier versions.
- Interrupting while a permission prompt or a question is open now ends the turn. The tool call is still answered (denied or declined), so the conversation stays valid, but the model is not called again. The terminal shows the same "Interrupted" notice as for a running turn.
- Headless runs (`-p`) connect the MCP servers configured in settings before the request, so their tools are available.
- Headless runs no longer write a `default.jsonl` transcript of file-history checkpoints or point `latest` at it; `eagent --resume` after a headless run resumed a session without metadata and failed.
- The interactive question prompt read the terminal width after its early return, so React could see a different hook count between renders.

## [0.1.1] - 2026-09-04

### Changed

- Updated the public project status after the first npm publication and registry cold-cache verification.

## [0.1.0] - 2026-08-15

### Added

- First npm-distributable Easy Agent CLI release.
- Single-file ESM bundle with source maps and no runtime dependency tree.
- Node.js 22 runtime gate, npm package boundary checks, and release verification.
- npm-backed macOS/Linux installer and provenance-enabled tag release workflow.

### Changed

- The npm package and primary command are named `eagent`.
- `easy-agent` is installed as the long command alias.
- The former development-only `agent` command is no longer registered because it is ambiguous and collision-prone.

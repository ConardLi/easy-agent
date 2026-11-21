# Configuration migration and rollback

This migration release reads retired settings only at one compatibility boundary and converts them to the canonical profile contract. All new writes use canonical fields. Compatibility will stop participating in effective configuration in the **next explicitly announced breaking release**. Its version number and release date must be announced before removal; no specific version is promised here.

## Preview and apply

```bash
eagent config migrate --scope user --json
eagent config migrate --scope user --apply
eagent config migrate --scope local
```

Scopes are `user`, `project` and `local`. The desktop Models page offers **Preview migration**, then **Back up and apply**. SDK uses `previewConfigMigration(scope)` and `applyConfigMigration(scope, revision)`; RPC uses `config/migrationPreview` and `config/migrationApply`. Preview does not execute helpers or send model requests, and redacts credentials and headers. Conflicts prevent apply.

Apply locks the file, verifies the displayed revision against both the file and runtime context, and writes an exact original-byte backup beside it: `settings.json.pre-standardization-<timestamp>.bak` (or the local file's corresponding name). Backups are private, `0600` on POSIX; Windows uses account ACLs. A changed file or a restarted runtime requires another preview. Repeating a canonical migration creates neither another profile nor another backup.

Shell configuration, CI Secrets and external credentials are never rewritten. Update those explicitly using the table below. Rebuild the runtime after migrating environment; supported setting edits otherwise apply to the next request. Normal settings saves also canonicalize retired fields with a private original-file backup.

## Field mapping

| Retired field or variable | Canonical target / handling |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | One `EASY_AGENT_API_KEY`; preserve an explicit old Anthropic connection |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` | `EASY_AGENT_BASE_URL`, `EASY_AGENT_MODEL`, with explicit `EASY_AGENT_PROTOCOL=anthropic` |
| Missing profile `protocol` | Migration alone restores the old Anthropic semantics; new profiles require a protocol |
| Raw main, role or classifier model | Stable `legacy-<hash>` profile only with confirmed old connection evidence; no model upgrade |
| `defaultModel` | `model` profile ID; preserve the old fallback below every trusted `model` selection |
| Global `apiKeyHelper` | `models.<selected-id>.apiKey: { helper }`, only if one original target is unambiguous |
| Authentication in `headers` | One explicit `authentication` policy referencing `apiKey`; multiple or conflicting secrets block migration |
| Profile `countTokens` | `protocolOptions.anthropic.countTokens`, preserving true and false |
| Profile `promptCacheKey` | Selected OpenAI protocol's `protocolOptions.<protocol>.promptCacheKey` |
| `alwaysThinkingEnabled`, `features.thinking`, `features.thinkingInRequests` | `reasoning.mode`, accounting for the old actual request prohibition |
| `features.thinkingBudget`, `MAX_THINKING_TOKENS` | `reasoning.budgetTokens` / `EASY_AGENT_REASONING_BUDGET_TOKENS`; old 0 means mode off |
| `effortLevel`, `features.effort` | `reasoning.effort` |
| `CLAUDE_CODE_DISABLE_THINKING` | `EASY_AGENT_REASONING=off` |
| `features.adaptiveThinking`, `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Selected Anthropic profile's `protocolOptions.anthropic.adaptiveThinking` |
| `features.interleavedThinking`, `DISABLE_INTERLEAVED_THINKING` | Selected Anthropic profile's `protocolOptions.anthropic.interleavedThinking` |
| `features.effortForAllModels`, `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | Explicit capability on one applicable profile; ambiguous targets block migration |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | `EASY_AGENT_MAX_CONTEXT_TOKENS` |
| `CLAUDE_CODE_MAX_RETRIES` | `EASY_AGENT_MAX_RETRIES`, including 0 |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS` |
| `WEB_SEARCH_ADAPTER` | `EASY_AGENT_WEB_SEARCH_BACKEND` (`api` or `bing`) |
| `MCP_CONNECT_TIMEOUT` | `EASY_AGENT_MCP_CONNECT_TIMEOUT_MS` |
| `EASY_AGENT_ENABLE_TOOL_SEARCH`, `ENABLE_TOOL_SEARCH` | settings `toolSearch` / `toolSearchAutoThreshold`, or `--tool-search`; `auto:N` retains its threshold |
| `claudeMdExcludes` | `agentMdExcludes`, union with existing exclusions so rules stay excluded |

Existing canonical feature, debug, proxy, OS and external-tool variables keep their names. User-declared references to any variable, including provider names, remain valid; they are not automatic configuration aliases.

## Conflicts and intentional changes

Two equal old credentials merge. Two different old credentials block the connection migration without displaying either secret. A complete canonical connection wins over residual old connection variables; it is never filled with an old key or address. A token name does not imply Bearer authentication: verify gateways that depended on the previous duplicate `Authorization` and `x-api-key` headers, then explicitly choose their authentication policy.

Saved profiles selected by settings, an Agent, CLI/SDK overrides, managed policy or the single-profile default own their declared credential source. An unused old credential conflict does not prevent startup or migration, including when the old variables appear in the same file. An explicit `${EASY_AGENT_API_KEY}` or vendor-variable reference keeps its own value; a missing reference remains an error and never borrows the old connection's key. Profiles newly created from an actual legacy connection retain the credential produced by that migration.

An independently configured legacy role or classifier retains its original model, endpoint and credential even when the main profile uses a canonical connection. Migration may preserve an explicit vendor-variable reference for that role; it never substitutes the main profile's API Key. Conflicting old credentials still prevent migration when a role actually needs that old connection.

Unknown profile IDs no longer mean raw Anthropic models. With no configuration there is no fixed Claude fallback; one valid profile can be auto-selected, several require a default. Historical sessions map raw names only to a unique confirmed profile, otherwise request a new selection.

Unknown models no longer get all Claude reasoning features automatically. `reasoning.mode=auto` is conservative; explicitly requested unsupported reasoning reports how to configure capabilities. Ordinary `ultrathink` text does not change reasoning. Adaptive/interleaved details belong to the selected Anthropic adapter, not a global switch.

Boolean false/0 now mean false. Integers, enums and credential references are fully validated. Priority is defaults → user → selected Harness → project → local → environment → explicit CLI/SDK/session → policy. Old environment overrides no longer beat explicit choices or managed policy. Trust, deny rules, restrictive hook disabling and rule exclusions keep their safety behavior.

## Roll back

Stop active runtimes. Restore each migrated file from its printed backup, preserving the private permissions. Install the previous known-good package version (record it with `eagent --version` before upgrading), and restore any shell or CI variable changes you made separately. Do not publish backups: they may contain old inline secrets. Backups are exact originals, so rollback does not reconstruct or guess old fields. Canonical profiles are not reverse-translated at runtime.

## Compatibility removal checklist

Before the next announced breaking release: publish its version/date and this mapping, require canonical writes from CLI/SDK/RPC/ACP/desktop, retain the backup/rollback path, remove retired names from effective parsing, keep diagnostic detection and explicit user references, and rerun authentication, trust, migration and request regressions. Remove the old fixed model only from compatibility conversion after users have been notified. Historical tutorials and third-party formats remain unchanged.

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

### Changed

- The npm description and keywords describe product capabilities.
- The development milestone table moved from the README to `docs/learning-path.md`.
- The system prompt is written once per session so later turns reuse the provider prompt cache. The date has day precision and git status is a session-start snapshot. Changes to AGENT.md, memory, language, output style, skills, agents, or the date reach the model as a hidden context update before the next message. `/clear`, compaction, and resume rebuild the prompt. Anthropic markers now cover both system blocks, so a full conversation is read from cache on the next user message.
- The tool-turn limit per request is configurable with `--max-turns <n>` or the `maxTurns` setting. The interactive REPL default rises from 50 to 200, and reaching the limit explains how to continue. Headless runs keep the 50-turn default and the `error_max_turns` result.
- `verify:release` also runs the host sandbox tests. The release workflow runs the gate on macOS and Ubuntu and the core tests on Windows before publishing, and publishes the verified artifact without rebuilding it.

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

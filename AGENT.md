# AGENT.md

This file provides guidance to AI agents when working with code in this repository.

## What this project is

Easy Agent is a **terminal-native agentic coding CLI** (published as the `agent` binary) that aims to recreate Claude Code from scratch in TypeScript / Node.js.

- Runtime: Node 22+, ESM, strict TS, target ES2022, JSX `react-jsx`
- TUI: React 19 + Ink 7 (no web framework)
- Package manager: **npm** (`package-lock.json` is canonical — no pnpm/yarn/bun lockfiles)
- Single-package repo (no monorepo)

The code is organized into roughly five layers, visible as top-level dirs under `src/`:

1. **Interaction** — Ink/React terminal UI (`src/ui/`)
2. **Orchestration** — multi-turn session flow and slash commands (`src/commands/`, `src/session/`)
3. **Agentic loop** — reason → tool call → observe (`src/core/`, `src/agents/`)
4. **Tooling** — file/shell/search/web/MCP, with permissions and sandboxing (`src/tools/`, `src/services/`, `src/permissions/`, `src/sandbox/`)
5. **Model communication** — pluggable providers over `llm-bridge` (Anthropic, OpenAI-compatible, Gemini, Ollama)

The project follows a numbered stage roadmap; it is currently on Stage 32 of 37.

## Commands (the non-obvious ones)

There is **no** `npm test`, **no linter, no formatter, no CI workflow, no `.github/` directory**. All "tests" are `tsx`-run smoke scripts wired up directly in `package.json`. The genuinely useful entries:

- **Build:** `npm run build` → `tsc` (outputs `dist/`)
- **Dev (no rebuild needed):** `npm run dev` → `tsx src/entrypoint/cli.ts`
- **Start built binary:** `npm start` → `node dist/entrypoint/cli.js`
- **Stage smokes:** `npm run test:stage20` … `test:stage32`
- **Domain smokes:** `test:streaming`, `test:tasks`, `test:mcp`, `test:skills`, `test:sandbox`, `test:agents`, `test:filehistory`, `test:resilience`
- **Stage 24 has many sub-suites:** `test:stage24-md`, `…-clear`, `…-ui`, `…-ask`, `…-transcript`, `…-perm`, `…-stream`, `…-input`, `…-group`, `…-statusline`, `…-command`

### Script path inconsistency

Most `test:*` commands run a file under `src/scripts/…`, but **`test:stage30` is the exception** — it runs the top-level `scripts/verify-multi-protocol.ts` (no `src/` prefix). The top-level `scripts/` directory also holds several other `verify-*.ts` files that are **not** wired to any npm script; invoke them directly with `npx tsx scripts/verify-<name>.ts`.

## Gotchas

- **Two similar-looking config dirs — they are NOT the same:**
  - `.claude/` (`skills/`, `agents/`, `commands/`) — Claude Code integration config
  - `.easy-agent/` (`skills/`, `agents/`, `commands/`, `settings.json`) — the agent's **own** runtime config (user- and project-scoped)
  Don't merge them or move files between them.
- **`step/` is intentional tutorial code**, not a build artifact. It holds compact milestone files (`step1.js` … `step32.js`) that mirror the implementation in `src/`. Do not delete or "clean it up".
- **`dist/` is tracked in git** alongside `node_modules/`. Rebuilding with `npm run build` regenerates it; this is expected, not a mistake.
- **`.env` exists in the repo root.** Treat it as a sample/placeholder, not authoritative secrets.
- **No `CONTRIBUTING.md`**; per the README, external contributions are not accepted yet, so conventions may shift. Don't expect a project-wide style guide.
- **Multi-provider model config** lives in user/project `settings.json`:
  - Anthropic: provider names pass through directly
  - Others: use `protocol` + `baseURL` + `${ENV_VAR}` interpolation for API keys
  - Relevant env vars: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `WEB_SEARCH_API_KEY`
- **Notable CLI flags:** `--print` (headless JSON output), `--plan`, `--auto`, `--dump-system-prompt`, `--model <name-or-profile>`.

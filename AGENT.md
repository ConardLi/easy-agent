# AGENT.md

This file provides guidance to AI agents when working with code in this repository.

## What this project is

Easy Agent is a **terminal-native agentic coding CLI** published as the `eagent` npm package. It installs the `eagent` command and the `easy-agent` long alias.

- Runtime: Node 22+, ESM, strict TS, target ES2022, JSX `react-jsx`
- TUI: React 19 + Ink 7 (no web framework)
- Package manager: **npm** (`package-lock.json` is canonical — no pnpm/yarn/bun lockfiles)
- Single-package repo (no monorepo)

The code is organized into five broad layers:

1. **Interaction** — Ink/React terminal UI (`src/ui/`)
2. **Orchestration** — multi-turn session flow, slash commands, usage/state (`src/commands/`, `src/session/`, parts of `src/core/`)
3. **Agentic loop** — reason → tool call → observe (`src/core/`, `src/agents/`)
4. **Tooling** — file/shell/search/web/MCP/local tools with permissions and sandboxing (`src/tools/`, `src/permissions/`, `src/sandbox/`, `src/services/mcp/`)
5. **Model communication** — provider profiles and streaming LLM I/O over `llm-bridge` (`src/services/api/`)

The numbered roadmap is complete through **Stage 36**. The `eagent` package is published on npm, and the post-publication registry cold check passes.

## Commands (the non-obvious ones)

Tests are smoke/characterization scripts listed in `scripts/verify-production.ts`; the release workflow runs the Stage 36 verification before publishing.

- **Offline tests:** `npm test` runs the `core`, `extensions`, and `ui` groups (the same set as `verify:production`, without typecheck/lint/build). `npm test -- --list` prints them.
- **Lint / format:** Biome, configured in `biome.jsonc`. `npm run lint` (errors and warnings fail; part of `verify:production`), `npm run format`, `npm run format:check`. Rules switched off in `biome.jsonc` carry a reason; keep it that way.
- **Typecheck:** `npm run typecheck` → `tsc --noEmit`
- **Source hygiene:** `npm run check:source-hygiene` (part of `verify:production`) rejects roadmap stage numbers, development-plan references, reference-implementation pointers, and tutorial wording in `src/` (excluding `src/scripts/`). Legitimate matches go into `ALLOWED_MATCHES` in `scripts/check-source-hygiene.ts` with a reason.
- **Build:** `npm run build` → `tsup` (outputs the bundled `dist/eagent.js` + sourcemap)
- **Dev (no rebuild needed):** `npm run dev` → `tsx src/entrypoint/cli.ts`
- **Start built binary:** `npm start` → `node dist/eagent.js`
- **Stage smokes:** `npm run test:stage20` … `test:stage36`
- **Release gate:** `npm run verify:release` → `verify:production`, the `platform` sandbox group, then `src/scripts/test-stage36.ts` (bundle hygiene, third-party notices, tarball credential scan, installed Headless and PTY startup). See `docs/releasing.md`.
- **Third-party notices:** `npm run build` writes `dist/THIRD_PARTY_LICENSES.txt` via `scripts/third-party-notices.ts` and fails on a bundled license outside its allowlist; `--check` verifies the file is current.
- **Domain smokes:** `test:queryengine`, `test:providerstream`, `test:notices`, `test:streaming`, `test:tasks`, `test:mcp`, `test:skills`, `test:sandbox`, `test:agents`, `test:filehistory`, `test:resilience`
- **Stage 24 sub-suites:** `test:stage24-md`, `…-clear`, `…-ui`, `…-ask`, `…-transcript`, `…-perm`, `…-stream`, `…-input`, `…-group`, `…-statusline`, `…-command`
- **Smoke aliases:** `npm run smoke:sandbox`, `npm run smoke:bash-sandbox`

For a smoke script not exposed as an npm script, run it directly with `npx tsx path/to/script.ts`.

### Script path inconsistency

Most `test:*` commands run files under `src/scripts/`, but **`test:stage30` is the exception**: it runs top-level `scripts/verify-multi-protocol.ts`. The top-level `scripts/` directory also contains `verify-*.ts` files that are not all wired to npm scripts; invoke them directly with `npx tsx scripts/verify-<name>.ts`.

## Gotchas

- **Two similar-looking config dirs are distinct:**
  - `.claude/` (`skills/`, `agents/`, `commands/`) — Claude Code integration config
  - `.easy-agent/` (`skills/`, `agents/`, `commands/`, `settings.json`) — Easy Agent's own runtime config
  Do not merge them or move files between them.
- **`step/` is intentional tutorial code**, not a build artifact. It holds milestone snapshots (`step1.js` … `step35.js`) that mirror implementation stages; do not delete or clean it up.
- **`dist/` is generated and ignored by git**. Rebuilding with `npm run build` replaces it with the single-file release artifact and sourcemap.
- **Secrets/config caution:** `.env` and `.easy-agent/settings.json` may contain local provider settings or secret-looking values. Do not copy token values into docs or output.
- **README is the product entry.** The release gate rejects roadmap stage progress or `step/` snapshot links in `README.md` / `README.zh-CN.md` and checks that every relative link resolves. The milestone table lives in `docs/learning-path.md` and `docs/learning-path.zh-CN.md`.
- **No `CONTRIBUTING.md`**; per the README, external contributions are not accepted yet, so conventions may shift.
- **Multi-provider model config** lives in user/project `settings.json`:
  - Anthropic provider names pass through directly
  - Other providers use `protocol` + `baseURL` + `${ENV_VAR}` interpolation for API keys
  - Relevant env vars: `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `WEB_SEARCH_API_KEY`
- **Notable CLI flags:** `--print` (headless JSON output), `--plan`, `--auto`, `--dump-system-prompt`, `--model <name-or-profile>`.

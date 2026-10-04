# Testing

## Production gate

Run the same offline gate used by pull requests:

```bash
npm ci
npm run verify:production
```

The command runs TypeScript validation, lint, the format check, the source hygiene check, the frontend boundary check, builds the distributable CLI, and executes the `core`, `extensions`, and `ui` test groups. Any failed test or timeout returns a non-zero exit code. `npm run verify:release` runs this gate, then the `platform` group, then the package and installation checks; see [Releasing](./releasing.md).

`npm test` runs only the three test groups, without typecheck, lint, or build. It selects the same tests as the gate; `npm test -- --list` prints them.

## Lint and formatting

[Biome](https://biomejs.dev/) lints and formats `src/`, `scripts/`, and the root configuration files. `step/`, the golden fixtures, and `package-lock.json` are excluded. The configuration is `biome.jsonc`; every rule switched off there has a comment giving the reason.

```bash
npm run lint           # fails on errors and warnings
npm run format         # rewrite files in place
npm run format:check   # report files that differ from the formatter output
```

Lint and the format check are part of `verify:production`. Run `npm run format` before committing.

## Frontend boundaries

The terminal UI and the entry points use the session SDK (`src/sdk/`) and never load the modules that hold conversation state or run turns: the QueryEngine and agentic loop, session storage and file history, the `state/` stores, plan files, thinking settings, the teammate mailbox, permission checks, and the Bash tool. `npm run check:frontend-boundaries` enforces this; type-only imports are allowed. The list and the reason for each entry live in `scripts/check-frontend-boundaries.ts`.

The formatter collapses repeated spaces in JSX text. Write text that needs them, such as indentation inside a `<Text>`, as a string expression: `<Text>{"  ↳ "}{label}</Text>`.

`.git-blame-ignore-revs` lists the bulk formatting commit. GitHub skips it in blame views; run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once to do the same locally.

Each offline test process receives a temporary `HOME`, `USERPROFILE`, XDG directories, and Windows application-data directories. Provider credentials, API endpoints, MCP settings, editor overrides, and `EASY_AGENT_*` feature settings inherited from the developer environment are removed. Tests must create their own configuration and fixtures under the assigned temporary directories.

## Coverage inventory

| Area | Included checks | Execution |
| --- | --- | --- |
| Core flow | CLI and Headless protocols, the session SDK contract (events, interaction requests, plan follow-ups, deny rules and trust under the SDK, multi-session isolation, `/resume` handles), QueryEngine commands, provider stream adapters, tools, ToolSearch, MCP content and recovery, Skills, tasks, and agents | `core` |
| Permissions | Allow/deny behavior, structured Bash read-only analysis, realpath and symbolic-link boundaries, Auto Mode configuration, Plan Mode paths, and sandbox policy | `core` |
| Storage and configuration | Configuration precedence and source shapes, workspace trust, credential inheritance, headless routing, session JSONL and restore shape, file history, and retention | `core`, `extensions` |
| Extensions | Worktrees, agent teams, hooks, commands, web and multimodal tools, plugins, and resilience | `extensions` |
| UI | Ink rendering, input, transcript, permission prompts, progress, status line, and plugin management | `ui` |
| Release | Package metadata, README contract, bundle hygiene, source map, third-party notices, tarball contents and credential scan, isolated installation, installed Headless and interactive startup, installer behavior, and old Node failure path | `verify:release`, `test:stage36` |
| Platform | Host sandbox and Bash sandbox integration | `platform` |
| External | Real provider streaming, ToolSearch, Auto Mode classifier requests, and plugin compatibility against a supplied package | `live`, `verify:plugin` |

The checked-in characterization fixtures are:

- `cli-headless-characterization.golden.txt` for CLI flags, stdin merging, and text, JSON, and stream JSON output.
- `queryengine-characterization.golden.txt` for local commands and orchestration events.
- `interactive-session-characterization.golden.txt` for interactive turns: provider requests, permission and question prompts, interrupt, plan approval, background wake-ups, the session transcript, and resume.
- `providerstream-characterization.golden.txt` for provider request translation and stream events.
- `config-session-characterization.golden.txt` for configuration precedence, session JSONL, and restored session data.

## Execution groups

| Group | Command | Default gate |
| --- | --- | --- |
| `core` | `npm run verify:production:core` | Yes |
| `extensions` | `npm run verify:production:extensions` | Yes |
| `ui` | `npm run verify:production:ui` | Yes |
| `platform` | `npm run verify:production:platform` | macOS and Linux CI |
| `live` | `npm run verify:production:live` | No |

List every test selected by a group without running it:

```bash
node --import tsx scripts/verify-production.ts --group core --list
```

Multiple `--group` options may be combined. Tests in the default gate run sequentially with independent user directories so failures are reproducible and shared process state cannot leak between test files.

Run the Bash read-only security regression suite directly while changing command parsing or permission behavior:

```bash
npm run test:bash-readonly
```

Run the workspace path boundary suite after changing file tools, allowed roots, file history, or path handling:

```bash
npm run test:path-boundary
```

Run the persistence suite after changing settings, runtime state, tasks, teams, sessions, or atomic file writes:

```bash
npm run test:persistence
```

Run the subprocess suite after changing Bash, PowerShell, hooks, the status line, or process cleanup:

```bash
npm run test:controlled-process
```

Run the Hooks suite after changing Hook settings, shell selection, or event handling:

```bash
npm run test:stage22
npm run test:hooks-hardening
```

Run the configuration trust suite after changing settings precedence, environment loading, providers, MCP, plugins, sandbox settings, or headless startup:

```bash
npm run test:config-trust
```

## Source hygiene

`npm run check:source-hygiene` scans production code under `src/` for roadmap stage numbers, development-plan references, pointers to a reference implementation, and tutorial or simplification wording. Comments should describe current behavior, constraints, and reasons.

`src/scripts/` is excluded because it holds test and smoke scripts that are not bundled, and their stage-numbered names are kept for command compatibility. `step/`, `article/`, and historical development documents are outside the scanned tree.

A legitimate match, such as the Explanatory output style's teaching wording, goes into `ALLOWED_MATCHES` in `scripts/check-source-hygiene.ts` with a reason. An allowance that no longer matches any line fails the check, so the list cannot go stale.

The bundle is not minified, so comments from application modules ship in `dist/eagent.js`. The release gate runs `node --import tsx scripts/check-source-hygiene.ts --bundle dist/eagent.js`, which applies the same rules and allowances to every `src/` module in the bundle and fails if a module from an excluded directory was bundled or no module markers were found.

## Platform and external checks

Platform tests exercise the actual host sandbox and therefore run separately from the portable offline gate:

```bash
npm run verify:production:platform
```

Linux host tests require `bubblewrap`, `socat`, `rg`, and permission to create unprivileged user, PID, and network namespaces. The suite verifies real read/write restrictions, allowed and denied network destinations, fail-closed configuration errors, output, and exit-code preservation.

Live tests require valid provider credentials and may consume API quota. They run only when requested explicitly:

```bash
npm run verify:production:live
```

Plugin compatibility verification also requires an explicit package path or repository URL and remains outside the default gate:

```bash
npm run verify:plugin -- /path/to/plugin
```

## Adding coverage

Add deterministic tests to the appropriate group in `scripts/verify-production.ts`. A test included in the offline gate must not read the real user profile, load the repository `.env`, call a public endpoint, require an interactive terminal, or mutate host state. Put host-dependent checks in `platform` and credentialed network checks in `live`.

## Agent Teams lifecycle

Run `npm run test:team-lifecycle` to check concurrent team writes, shared task ownership, control messages and crash recovery. This test is included in `npm run verify:production`.

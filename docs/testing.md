# Testing

## Production gate

Run the same offline gate used by pull requests:

```bash
npm ci
npm run verify:production
```

The command runs TypeScript validation, builds the distributable CLI, and executes the `core`, `extensions`, and `ui` test groups. Any failed test or timeout returns a non-zero exit code. `npm run verify:release` includes this gate before the package and installation checks.

Each offline test process receives a temporary `HOME`, `USERPROFILE`, XDG directories, and Windows application-data directories. Provider credentials, API endpoints, MCP settings, editor overrides, and `EASY_AGENT_*` feature settings inherited from the developer environment are removed. Tests must create their own configuration and fixtures under the assigned temporary directories.

## Coverage inventory

| Area | Included checks | Execution |
| --- | --- | --- |
| Core flow | CLI and Headless protocols, QueryEngine commands, provider stream adapters, tools, ToolSearch, MCP, Skills, tasks, and agents | `core` |
| Permissions | Allow/deny behavior, structured Bash read-only analysis, realpath and symbolic-link boundaries, Auto Mode configuration, Plan Mode paths, and sandbox policy | `core` |
| Storage and configuration | Configuration precedence and source shapes, session JSONL and restore shape, file history, and retention | `core`, `extensions` |
| Extensions | Worktrees, agent teams, hooks, commands, web and multimodal tools, plugins, and resilience | `extensions` |
| UI | Ink rendering, input, transcript, permission prompts, progress, status line, and plugin management | `ui` |
| Release | Package metadata, bundle, tarball contents, isolated installation, installer behavior, and old Node failure path | `verify:release` |
| Platform | Host sandbox and Bash sandbox integration | `platform` |
| External | Real provider streaming, ToolSearch, Auto Mode classifier requests, and plugin compatibility against a supplied package | `live`, `verify:plugin` |

The checked-in characterization fixtures are:

- `cli-headless-characterization.golden.txt` for CLI flags, stdin merging, and text, JSON, and stream JSON output.
- `queryengine-characterization.golden.txt` for local commands and orchestration events.
- `providerstream-characterization.golden.txt` for provider request translation and stream events.
- `config-session-characterization.golden.txt` for configuration precedence, session JSONL, and restored session data.

## Execution groups

| Group | Command | Default gate |
| --- | --- | --- |
| `core` | `npm run verify:production:core` | Yes |
| `extensions` | `npm run verify:production:extensions` | Yes |
| `ui` | `npm run verify:production:ui` | Yes |
| `platform` | `npm run verify:production:platform` | macOS CI |
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

## Platform and external checks

Platform tests exercise the actual host sandbox and therefore run separately from the portable offline gate:

```bash
npm run verify:production:platform
```

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

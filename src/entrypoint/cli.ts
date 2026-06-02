#!/usr/bin/env node
import { loadEnv } from "../utils/loadEnv.js";
loadEnv();
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import type { PermissionMode } from "../permissions/permissions.js";

const VERSION = "0.1.0";

function parsePermissionMode(argv: string[]): PermissionMode | undefined {
  if (argv.includes("--auto")) return "auto";
  if (argv.includes("--plan")) return "plan";

  const modeIndex = argv.indexOf("--permission-mode");
  const value = modeIndex !== -1 ? argv[modeIndex + 1] : undefined;
  if (value === "default" || value === "plan" || value === "auto") {
    return value;
  }

  return undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log("easy-agent v" + VERSION);
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
easy-agent v${VERSION} — Terminal-native agentic coding system

Usage:
  agent [options]

Options:
  -v, --version               Print version and exit
  -h, --help                  Show this help message
  --model <model>             Override the LLM model
  --resume [session-id]       Resume the latest or a specific session
  --plan                      Start in plan mode (read-only tools only)
  --auto                      Start in auto mode (allow all tools)
  --permission-mode <mode>    Permission mode: default | plan | auto
  --settings <path>           Load an external settings.json as the flag layer
                              (inline --model / --permission-mode still win)
  --agent-teams               Enable Agent Teams (stage 21 — TeamCreate /
                              TeamDelete / SendMessage tools). Equivalent
                              to setting EASY_AGENT_TEAMS=1.
  --dump-system-prompt        Print the assembled system prompt and exit

Commands (in REPL):
  /help                       Show available commands
  /clear                      Clear conversation history
  /config [list|get|set]      Inspect or change settings (--user/--project/--local)
  /mode [default|plan|auto]   Inspect or switch permission mode
  /tasks [task|todo|reset]    Switch task system or reset the task graph
  /mcp [tools|reconnect <n>]  Inspect or reconnect MCP servers
  /skills                     List loaded skills (user + project scope)
  /<skill-name> [args]        Invoke a skill by name
  /<command> [args]           Invoke a user-defined command (.easy-agent/commands)
  /output-style [name]        Inspect or switch the answer style
  /agents                     List built-in + custom sub-agent definitions
  /hooks                      Show configured lifecycle hooks
  /history                    Show session history

Extensions (stage 23 — Markdown + frontmatter):
  Output styles: ~/.easy-agent/output-styles/<name>.md (default/Explanatory/Learning built-in)
  Commands:      ~/.easy-agent/commands/<name>.md → /<name>; team/review.md → /team:review
                 Body supports $ARGUMENTS / $1 / $2; frontmatter: description, argument-hint, model, allowed-tools

Sub-agents (stage 19):
  Built-in: general-purpose, Explore
  Custom:   add <cwd>/.easy-agent/agents/<name>.md or ~/.easy-agent/agents/<name>.md
  See doc/DEVELOPMENT-PLAN.md §19 for the agent file frontmatter schema.

Agent Teams (stage 21 — requires --agent-teams or EASY_AGENT_TEAMS=1):
  TeamCreate({ team_name })                  Start a team-coordinated session
  Agent({ name, team_name, run_in_background: true, ... })  Spawn a named teammate
  SendMessage({ to, message, summary })      Drop a message in a teammate's inbox
  TeamDelete()                               Disband the active team
  Disabled by default; the model never sees the team tools when off.

Hooks (stage 22 — user-defined shell scripts on lifecycle events):
  Configure in ~/.easy-agent/settings.json or <cwd>/.easy-agent/settings.json:
    {
      "hooks": {
        "PreToolUse":       [{ "matcher": "Bash", "hooks": [{ "command": "..." }] }],
        "PostToolUse":      [{ "matcher": "*",    "hooks": [{ "command": "..." }] }],
        "UserPromptSubmit": [{ "hooks": [{ "command": "..." }] }],
        "SessionStart":     [{ "matcher": "startup", "hooks": [{ "command": "..." }] }],
        "Stop":             [{ "hooks": [{ "command": "..." }] }],
        "SubagentStop":     [{ "matcher": "general-purpose", "hooks": [{ "command": "..." }] }]
      }
    }
  Hook receives the event JSON on stdin; exit 2 + stderr blocks the action.
  Set EASY_AGENT_DISABLE_HOOKS=1 to disable all hooks globally.

Settings keys (stage 25 — in ~/.easy-agent/settings.json or <cwd>/.easy-agent/settings.json):
  env: { "KEY": "value" }        Inject env vars into Bash commands (trusted sources only)
  language: "japanese"           Preferred response language (injected into the system prompt)
  apiKeyHelper: "vault token"    Script whose stdout is used as the API token when none is in env
                                 (executed → trusted sources only)
  cleanupPeriodDays: 30          Transcript retention in days; 0 disables session persistence
  additionalDirectories: ["..."] Extra dirs the file tools may access beyond cwd (trusted sources only)
  disableAllHooks: true          Master switch — turns off every hook AND the statusLine
  respectGitignore: false        Let Glob/Grep search files .gitignore would hide (default: true)
  syntaxHighlightingDisabled: true   Render code blocks as plain text (no ANSI colors)
  prefersReducedMotion: true     Calm, static spinner (no animation) for reduced-motion users
  claudeMdExcludes: ["**/AGENT.md"]  Glob/abs-path list of AGENT.md files to skip loading
  enableAllProjectMcpServers: true   Auto-approve every server in <cwd>/.mcp.json (trusted folder)
  enabledMcpjsonServers: ["name"]    Approve specific .mcp.json servers
  disabledMcpjsonServers: ["name"]   Reject specific .mcp.json servers

  /compact                    Compact conversation context
  /exit, /quit, /bye          Exit the REPL
`);
    process.exit(0);
  }

  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;
  const dumpSystemPrompt = process.argv.includes("--dump-system-prompt");
  const permissionMode = parsePermissionMode(process.argv);

  // Build the in-memory `flag` settings source from argv and install it as the
  // highest-priority file-equivalent source BEFORE any loader runs. This makes
  // `--model` (and `--permission-mode`) part of the unified settings chain
  // rather than one-off props, so "CLI overrides files" holds everywhere.
  //
  // `--settings <path>` loads an external settings file as the *base* of the
  // flag layer; inline flags (`--model` / `--permission-mode`) are merged on
  // top so an explicit flag still wins over the file it was paired with.
  const { setFlagSettings } = await import("../config/sources.js");
  const flagSettings: Record<string, unknown> = {};
  const settingsIndex = process.argv.indexOf("--settings");
  const settingsPath = settingsIndex !== -1 ? process.argv[settingsIndex + 1] : undefined;
  if (settingsPath && !settingsPath.startsWith("--")) {
    const path = await import("node:path");
    const { readJsonSettingsFile } = await import("../utils/settings.js");
    const abs = path.isAbsolute(settingsPath) ? settingsPath : path.resolve(process.cwd(), settingsPath);
    const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(abs);
    if (parseError) {
      console.warn(`[easy-agent] ⚠ --settings ignored: ${parseError}`);
    } else if (raw && typeof raw === "object") {
      Object.assign(flagSettings, raw);
    }
  }
  if (model) flagSettings.model = model;
  if (permissionMode) flagSettings.mode = permissionMode;
  setFlagSettings(flagSettings);
  const resumeIndex = process.argv.indexOf("--resume");
  const resumeValue = resumeIndex !== -1 ? process.argv[resumeIndex + 1] : undefined;
  const resumeSessionId = resumeIndex !== -1 && resumeValue && !resumeValue.startsWith("--") ? resumeValue : null;
  const shouldResume = resumeIndex !== -1;

  // Skills must load BEFORE we render anything (live REPL or
  // --dump-system-prompt), because `buildSystemPrompt` reads the
  // skill registry to inject the <system-reminder> discovery block.
  // If we bootstrap after the dump branch, the dump shows an empty
  // skills section and users assume the feature is broken.
  const { bootstrapSkills } = await import("../services/skills/bootstrap.js");
  await bootstrapSkills(process.cwd()).catch((error) => {
    console.error(`[easy-agent] skills bootstrap failed: ${(error as Error).message}`);
  });

  // Agents (stage 19) — same reason as skills: the system prompt's
  // <system-reminder> for available sub-agent types is built from the
  // registry, so the registry has to be populated before any prompt
  // rendering. Built-ins are synchronous; user/project agents come from
  // disk so we await before continuing.
  const { bootstrapAgents } = await import("../agents/bootstrap.js");
  await bootstrapAgents(process.cwd()).catch((error) => {
    console.error(`[easy-agent] agents bootstrap failed: ${(error as Error).message}`);
  });

  // Output styles (stage 23) — must load before any system-prompt render
  // (live REPL or --dump-system-prompt) so the persisted `outputStyle`
  // preference and any custom styles are reflected in the prompt.
  const { bootstrapOutputStyles } = await import("../styles/bootstrap.js");
  await bootstrapOutputStyles(process.cwd()).catch((error) => {
    console.error(`[easy-agent] output-styles bootstrap failed: ${(error as Error).message}`);
  });

  // User-defined slash commands (stage 23) — loaded before the UI so the
  // suggestion list + dispatch see them on frame 1.
  const { bootstrapUserCommands } = await import("../commands/userCommands/bootstrap.js");
  await bootstrapUserCommands(process.cwd()).catch((error) => {
    console.error(`[easy-agent] commands bootstrap failed: ${(error as Error).message}`);
  });

  // Sandbox availability: if the user opted in via settings.json but
  // the host can't run sandbox-exec, surface the reason loudly. Silent
  // fall-back is a security footgun — users assume protection that
  // isn't there. Mirrors source code's `getSandboxUnavailableReason`.
  try {
    const { loadSandboxSettings, getSandboxUnavailableReason } = await import(
      "../sandbox/index.js"
    );
    const sandboxSettings = await loadSandboxSettings(process.cwd());
    const reason = getSandboxUnavailableReason(sandboxSettings.enabled);
    if (reason) {
      console.warn(`[easy-agent] ⚠ ${reason} Bash commands will run unsandboxed.`);
    }
  } catch {
    // Settings parse errors are surfaced by the permission loader; we
    // don't double-report here.
  }

  if (dumpSystemPrompt) {
    const cwd = process.cwd();
    const systemParts = await buildSystemPrompt({ cwd });
    const system = renderSystemPrompt(systemParts);
    console.log(system);
    process.exit(0);
  }

  // Trust gate (stage 25): before bringing up the REPL, make sure the user
  // trusts this folder. Declining exits; non-interactive sessions run
  // untrusted (project/local hooks + statusLine are then suppressed).
  if (process.stdin.isTTY) {
    const { ensureTrusted } = await import("../ui/trustGate.js");
    const trusted = await ensureTrusted(process.cwd());
    if (!trusted) {
      console.log("Not trusted — exiting. Re-run and choose to trust this folder to continue.");
      process.exit(0);
    }
  }

  // Stage 25 Tier 1 config — resolve trust-sensitive, execution-affecting
  // settings now that the trust decision is settled:
  //   - apiKeyHelper:         mint an auth token via a script (only if the env
  //                           doesn't already provide one).
  //   - additionalDirectories: widen the file-tool access boundary.
  //   - cleanupPeriodDays:     prune old transcripts / disable persistence.
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    const { resolveApiKeyFromHelper } = await import("../services/api/apiKeyHelper.js");
    const token = await resolveApiKeyFromHelper(process.cwd());
    if (token) process.env.ANTHROPIC_AUTH_TOKEN = token;
  }

  {
    const nodePath = await import("node:path");
    const nodeOs = await import("node:os");
    const { readTrustedStringArraySetting } = await import("../utils/settings.js");
    const { setAdditionalAllowedRoots } = await import("../tools/pathUtils.js");
    const raw = await readTrustedStringArraySetting(process.cwd(), "additionalDirectories").catch(() => []);
    const resolved = raw.map((dir) => {
      const expanded = dir.startsWith("~") ? dir.replace("~", nodeOs.homedir()) : dir;
      return nodePath.resolve(process.cwd(), expanded);
    });
    setAdditionalAllowedRoots(resolved);
  }

  {
    const { applySessionRetentionPolicy } = await import("../session/storage.js");
    await applySessionRetentionPolicy(process.cwd()).catch(() => {});
  }

  // Stage 25 Tier 2 config — snapshot the toggles that sync hot paths consult:
  //   - disableAllHooks:          master kill switch for hooks + statusLine.
  //   - syntaxHighlightingDisabled / prefersReducedMotion: UI render prefs.
  {
    const { refreshHookDisableFromSettings } = await import("../hooks/settings.js");
    await refreshHookDisableFromSettings(process.cwd()).catch(() => {});

    const { readMergedBooleanSetting } = await import("../utils/settings.js");
    const { setSyntaxHighlightingDisabled } = await import("../ui/markdown/highlight.js");
    const { setReducedMotion } = await import("../ui/motionPrefs.js");
    setSyntaxHighlightingDisabled(
      (await readMergedBooleanSetting(process.cwd(), "syntaxHighlightingDisabled").catch(() => undefined)) === true,
    );
    setReducedMotion(
      (await readMergedBooleanSetting(process.cwd(), "prefersReducedMotion").catch(() => undefined)) === true,
    );
  }

  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { DEFAULT_MODEL } = await import("../services/api/client.js");
  const { bootstrapMcp } = await import("../services/mcp/bootstrap.js");
  const { readMergedStringSetting } = await import("../utils/settings.js");

  // Resolve the model through the unified settings chain: flag (--model) →
  // local → project → user → built-in default. `--model` lives in the flag
  // source installed above, so it naturally wins.
  const resolvedModel = (await readMergedStringSetting(process.cwd(), "model")) ?? DEFAULT_MODEL;

  // Kick off MCP server connections IN THE BACKGROUND. The bootstrap
  // function seeds `pending` registry entries synchronously, then connects
  // each server in parallel — a slow `npx -y @mcp/server-foo` cold-start
  // (which can take 10–30s on first run while npm downloads the package)
  // would otherwise leave the terminal black, because we wouldn't render
  // the UI until it returned.
  //
  // Trade-off: if the user submits a query before MCP tools land, the
  // model just doesn't see them yet. They'll appear on the next turn.
  // This matches Claude Code's behavior — its `prefetchAllMcpResources`
  // runs inside `useManageMCPConnections` (a React useEffect), so the
  // REPL is interactive from frame 1 too.
  const { logWarn } = await import("../utils/log.js");
  void bootstrapMcp(process.cwd()).catch((error) => {
    logWarn(`MCP bootstrap failed: ${(error as Error).message}`);
  });

  // Mark the UI as live BEFORE render() so any background warning that
  // resolves during/after the first frame (e.g. a slow MCP connect failing)
  // is routed into the in-UI notice bus instead of being printed straight to
  // stderr where it would tear through Ink's rendered frame.
  const { setUiActive } = await import("../state/uiNoticeStore.js");
  setUiActive(true);

  const { waitUntilExit } = render(
    React.createElement(App, { model: resolvedModel, permissionMode, resumeSessionId, shouldResume }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error("Fatal: " + err.message);
  process.exit(1);
});

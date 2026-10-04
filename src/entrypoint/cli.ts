#!/usr/bin/env node
// Must stay first: gates the Node version and enables source maps before any
// other module body runs. See preflight.ts for why the ordering matters.
import "./preflight.js";
import type { PermissionMode } from "../permissions/permissions.js";
import { VERSION } from "../version.js";

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
    console.log(`eagent ${VERSION}`);
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    const { formatBuiltinCommandHelpColumns } = await import("../commands/builtinCommandHelp.js");
    console.log(`
Easy Agent v${VERSION} — Terminal-native agentic coding system

Usage:
  eagent [options]            (long alias: easy-agent)

Options:
  -v, --version               Print version and exit
  -h, --help                  Show this help message
  --model <handle>            Select the model: a "models" profile id (multi-
                              protocol: OpenAI/Gemini via settings.json) or a
                              raw Anthropic model name. See /model list.
  -p, --print [prompt]        Headless mode: run one non-interactive turn from
                              the prompt and/or piped stdin, print the result to
                              stdout, and exit. (e.g. echo "hi" | eagent -p)
  --output-format <fmt>       Headless output: text (default) | json | stream-json
                              json: one result object; stream-json: NDJSON stream
                              (system/init → assistant/user → result)
  --tool-search <mode>         ToolSearch mode: off | auto | on
  --max-turns <n>             Maximum tool turns per request (default: 200 in
                              the REPL, 50 with -p). Overrides the maxTurns setting.
  --resume [session-id]       Resume the latest or a specific session
  --plan                      Start in plan mode (read-only tools only)
  --auto                      Start in auto mode: an AI classifier auto-approves
                              safe tool calls and blocks risky ones (uncertain
                              cases fall back to confirmation)
  --permission-mode <mode>    Permission mode: default | plan | auto
  --dangerously-skip-permissions
                              Headless mode only: auto-approve tool calls that
                              would otherwise prompt (deny rules still apply).
                              Without it, -p denies such calls by default.
  --settings <path>           Load an external settings.json as the flag layer
                              (inline --model / --permission-mode still win)
  --trust-project-config      Trust project/local settings and .env for this
                              invocation without persisting the decision
  --agent-teams               Enable Agent Teams (TeamCreate / TeamDelete /
                              SendMessage tools). Equivalent
                              to setting EASY_AGENT_TEAMS=1.
  --dump-system-prompt        Print the assembled system prompt and exit

Commands (in REPL):
${formatBuiltinCommandHelpColumns()}

Extensions (Markdown + frontmatter):
  Output styles: ~/.easy-agent/output-styles/<name>.md (default/Explanatory/Learning built-in)
  Commands:      ~/.easy-agent/commands/<name>.md → /<name>; team/review.md → /team:review
                 Body supports $ARGUMENTS / $1 / $2; frontmatter: description, argument-hint, model, allowed-tools

Sub-agents:
  Built-in: general-purpose, Explore
  Custom:   add <cwd>/.easy-agent/agents/<name>.md or ~/.easy-agent/agents/<name>.md
  Frontmatter: name, description, tools, disallowedTools, model, maxTurns,
               permissionMode, isolation. The Markdown body is the system prompt.

Agent Teams (requires --agent-teams or EASY_AGENT_TEAMS=1):
  TeamCreate({ team_name })                  Start a team-coordinated session
  Agent({ name, team_name, run_in_background: true, ... })  Spawn a named teammate
  SendMessage({ to, message, summary })      Drop a message in a teammate's inbox
  TeamDelete()                               Disband the active team
  Disabled by default; the model never sees the team tools when off.

Hooks (user-defined shell scripts on lifecycle events):
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

Settings keys (in ~/.easy-agent/settings.json or <cwd>/.easy-agent/settings.json):
  env: { "KEY": "value" }        Inject env vars into Bash commands (trusted sources only)
  language: "japanese"           Preferred response language (injected into the system prompt)
  apiKeyHelper: "vault token"    Script whose stdout is used as the API token when none is in env
                                 (executed → trusted sources only)
  cleanupPeriodDays: 30          Transcript retention in days; 0 disables session persistence
  maxTurns: 200                  Maximum tool turns per request (REPL default 200, -p default 50)
  additionalDirectories: ["..."] Extra dirs the file tools may access beyond cwd (trusted sources only)
  disableAllHooks: true          Master switch — turns off every hook AND the statusLine
  respectGitignore: false        Let Glob/Grep search files .gitignore would hide (default: true)
  syntaxHighlightingDisabled: true   Render code blocks as plain text (no ANSI colors)
  prefersReducedMotion: true     Calm, static spinner (no animation) for reduced-motion users
  claudeMdExcludes: ["**/AGENT.md"]  Glob/abs-path list of AGENTS.md/AGENT.md files to skip loading
  enableAllProjectMcpServers: true   Auto-approve every server in <cwd>/.mcp.json (trusted folder)
  enabledMcpjsonServers: ["name"]    Approve specific .mcp.json servers
  disabledMcpjsonServers: ["name"]   Reject specific .mcp.json servers
  sandbox.enabled: true              Enable OS shell isolation on macOS/Linux
  sandbox.failClosed: true           Block shell execution when isolation is unavailable (default)
  sandbox.filesystem: {...}          Configure allowWrite/denyWrite/allowRead/denyRead
  sandbox.network: {...}             Optional domain policy and local IPC settings
`);
    process.exit(0);
  }

  const { hardenPrivateDataStorage } = await import("../utils/privateData.js");
  const privateDataReport = await hardenPrivateDataStorage({ projectCwd: process.cwd() });
  if (privateDataReport.issues.length > 0) {
    const first = privateDataReport.issues[0]!;
    console.warn(
      `[easy-agent] ⚠ Could not fully protect local data: ${first.path}: ${first.message}. ` +
        "Run /doctor for details.",
    );
  }

  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;
  const dumpSystemPrompt = process.argv.includes("--dump-system-prompt");
  const permissionMode = parsePermissionMode(process.argv);

  // Headless / print mode. `-p` / `--print` runs a single
  // non-interactive turn (stdin and/or the following arg → one Agentic Loop →
  // stdout → exit). The prompt argument is optional: when absent, input comes
  // from piped stdin. We only treat the token right after the flag as the
  // prompt when it isn't itself another flag.
  const printIndex = process.argv.findIndex((a) => a === "--print" || a === "-p");
  const isPrintMode = printIndex !== -1;
  const printPromptCandidate = isPrintMode ? process.argv[printIndex + 1] : undefined;
  const printPrompt = printPromptCandidate && !printPromptCandidate.startsWith("-") ? printPromptCandidate : undefined;
  // Bypass permissions (auto-approve `ask` prompts). Honored by the
  // headless callback; `deny` rules still apply. Currently only wired into
  // print mode.
  const bypassPermissions = process.argv.includes("--dangerously-skip-permissions");
  // Headless output format. `text` (default) prints just the final
  // answer; `json` emits a single machine-readable `result` object.
  const outputFormatIndex = process.argv.indexOf("--output-format");
  const outputFormat = outputFormatIndex !== -1 ? process.argv[outputFormatIndex + 1] : undefined;
  if (
    isPrintMode &&
    outputFormat !== undefined &&
    outputFormat !== "text" &&
    outputFormat !== "json" &&
    outputFormat !== "stream-json"
  ) {
    console.error(`[easy-agent] Unsupported --output-format: ${outputFormat}. Use 'text', 'json', or 'stream-json'.`);
    process.exit(1);
  }

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
  const searchIndex = process.argv.indexOf("--tool-search");
  if (searchIndex !== -1) {
    const mode = process.argv[searchIndex + 1];
    if (mode !== "off" && mode !== "auto" && mode !== "on") {
      console.error("[easy-agent] --tool-search requires off, auto or on.");
      process.exit(1);
    }
    flagSettings.toolSearch = mode;
  }
  const maxTurnsIndex = process.argv.indexOf("--max-turns");
  if (maxTurnsIndex !== -1) {
    const raw = process.argv[maxTurnsIndex + 1] ?? "";
    const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1) {
      console.error("[easy-agent] --max-turns requires a positive integer.");
      process.exit(1);
    }
    flagSettings.maxTurns = value;
  }
  if (model) flagSettings.model = model;
  if (permissionMode) flagSettings.mode = permissionMode;
  setFlagSettings(flagSettings);

  // Resolve workspace trust before loading project-controlled environment or
  // trust-sensitive settings. Non-interactive invocations use the persisted
  // trust decision unless the caller explicitly opts in for this process.
  const cwd = process.cwd();
  const trustProjectConfig = process.argv.includes("--trust-project-config");
  if (trustProjectConfig) {
    const { trustProjectForSession } = await import("../config/globalState.js");
    await trustProjectForSession(cwd);
  }

  const isNonInteractiveMode = isPrintMode || dumpSystemPrompt || !process.stdin.isTTY;
  if (!trustProjectConfig && !isNonInteractiveMode) {
    const { ensureTrusted } = await import("../ui/trustGate.js");
    const trusted = await ensureTrusted(cwd);
    if (!trusted) {
      console.log("Not trusted — exiting. Re-run and choose to trust this folder to continue.");
      process.exit(0);
    }
  }

  const resumeIndex = process.argv.indexOf("--resume");
  const resumeValue = resumeIndex !== -1 ? process.argv[resumeIndex + 1] : undefined;
  const resumeSessionId = resumeIndex !== -1 && resumeValue && !resumeValue.startsWith("--") ? resumeValue : null;
  const shouldResume = resumeIndex !== -1;

  // Plugins: `--plugin-dir <dir>` (repeatable) loads dev plugins from disk.
  const pluginDirs: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--plugin-dir" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
      pluginDirs.push(process.argv[i + 1]);
    }
  }
  // Trust and the flag settings layer are already settled above, and local
  // data was hardened first thing, so the workspace bootstrap only loads.
  const workspaceOptions = { cwd, pluginDirs, hardenPrivateData: false, services: false } as const;

  if (dumpSystemPrompt) {
    // Only the prompt-facing bootstrap: nothing configured by the workspace runs.
    const { loadWorkspace } = await import("../sdk/bootstrap.js");
    await loadWorkspace(workspaceOptions);
    const { buildSystemPrompt, renderSystemPrompt } = await import("../context/systemPrompt.js");
    const systemParts = await buildSystemPrompt({ cwd });
    const system = renderSystemPrompt(systemParts);
    console.log(system);
    process.exit(0);
  }

  const { createAgentRuntime } = await import("../sdk/index.js");
  const runtime = await createAgentRuntime(workspaceOptions);

  // Terminal render preferences, read once like the other startup settings.
  {
    const { readMergedBooleanSetting } = await import("../utils/settings.js");
    const { setSyntaxHighlightingDisabled } = await import("../ui/markdown/highlight.js");
    const { setReducedMotion } = await import("../ui/motionPrefs.js");
    setSyntaxHighlightingDisabled(
      (await readMergedBooleanSetting(cwd, "syntaxHighlightingDisabled").catch(() => undefined)) === true,
    );
    setReducedMotion((await readMergedBooleanSetting(cwd, "prefersReducedMotion").catch(() => undefined)) === true);
  }

  // Headless / print mode runs one turn and exits, so it never reaches the
  // interactive REPL below. It has no later UI phase: MCP servers and plugin
  // services connect before the request so their tools are usable.
  if (isPrintMode) {
    await runtime.startServices({ mcpServers: true, wait: true });
    const { runHeadless } = await import("./headless.js");
    await runHeadless({
      runtime,
      promptArg: printPrompt,
      permissionMode,
      bypassPermissions,
      outputFormat: outputFormat === "json" ? "json" : outputFormat === "stream-json" ? "stream-json" : "text",
    });
    return;
  }

  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { getDefaultModel } = await import("../services/api/client.js");
  const { readMergedStringSetting } = await import("../utils/settings.js");

  // Resolve the model through the unified settings chain: flag (--model) →
  // local → project → user → built-in default. `--model` lives in the flag
  // source installed above, so it naturally wins.
  //
  // The resolved value is a model *handle* — either a declared
  // `models` profile id or a raw model name. When no explicit `model` is set,
  // fall back to `defaultModel` (the multi-profile default) before the built-in.
  const resolvedModel =
    (await readMergedStringSetting(cwd, "model")) ??
    (await readMergedStringSetting(cwd, "defaultModel")) ??
    getDefaultModel();

  // MCP servers and plugin services connect in the background: a slow `npx`
  // cold start would otherwise leave the terminal black. If the user submits
  // before MCP tools land, the model sees them on the next turn.
  await runtime.startServices({ mcpServers: true, wait: false });

  // Mark the UI as live BEFORE render() so any background warning that
  // resolves during/after the first frame (e.g. a slow MCP connect failing)
  // is routed into the in-UI notice bus instead of being printed straight to
  // stderr where it would tear through Ink's rendered frame.
  const { setUiActive } = await import("../state/uiNoticeStore.js");
  setUiActive(true);

  const { waitUntilExit } = render(
    React.createElement(App, { runtime, model: resolvedModel, permissionMode, resumeSessionId, shouldResume }),
    { exitOnCtrlC: false },
  );
  await waitUntilExit();
}

main().catch((err) => {
  console.error("Fatal: " + err.message);
  process.exit(1);
});

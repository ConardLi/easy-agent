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
  --agent-teams               Enable Agent Teams (stage 21 — TeamCreate /
                              TeamDelete / SendMessage tools). Equivalent
                              to setting EASY_AGENT_TEAMS=1.
  --dump-system-prompt        Print the assembled system prompt and exit

Commands (in REPL):
  /help                       Show available commands
  /clear                      Clear conversation history
  /mode [default|plan|auto]   Inspect or switch permission mode
  /tasks [task|todo|reset]    Switch task system or reset the task graph
  /mcp [tools|reconnect <n>]  Inspect or reconnect MCP servers
  /skills                     List loaded skills (user + project scope)
  /<skill-name> [args]        Invoke a skill by name
  /agents                     List built-in + custom sub-agent definitions
  /history                    Show session history

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
  /compact                    Compact conversation context
  /exit, /quit, /bye          Exit the REPL
`);
    process.exit(0);
  }

  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;
  const dumpSystemPrompt = process.argv.includes("--dump-system-prompt");
  const permissionMode = parsePermissionMode(process.argv);
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

  // Stage 21 — Agent Teams startup notice. Mirrors source's
  // `isAgentSwarmsEnabled()` boot log. Two reasons we log loudly:
  //   1. Three extra tools (TeamCreate / TeamDelete / SendMessage)
  //      become visible to the model — users should know.
  //   2. Team metadata is persisted under ~/.easy-agent/teams/ — users
  //      who didn't realize they enabled it deserve a one-line heads-up.
  const { isAgentTeamsEnabled } = await import("../utils/agentTeamsEnabled.js");
  if (isAgentTeamsEnabled()) {
    console.warn(
      "[easy-agent] Agent Teams enabled — TeamCreate / TeamDelete / SendMessage tools are exposed to the model.",
    );
  }

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

  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { DEFAULT_MODEL } = await import("../services/api/client.js");
  const { bootstrapMcp } = await import("../services/mcp/bootstrap.js");

  const resolvedModel = model ?? DEFAULT_MODEL;

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
  void bootstrapMcp(process.cwd()).catch((error) => {
    console.error(`[easy-agent] MCP bootstrap failed: ${(error as Error).message}`);
  });

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

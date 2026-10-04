/**
 * Registry command group — `/skills`, `/agents`, `/hooks`, `/mcp`.
 *
 * Extracted verbatim from queryEngine.ts; behavior is unchanged. These are the
 * read-only "what's loaded right now?" inspectors over the various startup
 * registries, plus `/mcp`'s tools/reconnect subcommands. Output is rendered as
 * system notices and never sent to the model.
 */

import { getMcpRegistry, getMcpRegistryEntry } from "../../../services/mcp/registry.js";
import { reconnectMcpServer } from "../../../services/mcp/bootstrap.js";
import { getAllUserInvocableSkills } from "../../../services/skills/registry.js";
import { getAllAgents } from "../../../agents/registry.js";
import { loadHooksDiagnosticReport, HOOK_EVENTS, type HookEvent, type HooksSettings } from "../../../hooks/index.js";
import type { ScopedMcpServerConfig } from "../../../types/mcp.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";
import { refreshActivePlugins } from "../../../plugins/runtime.js";

/**
 * Handle `/skills` — list loaded skills, or atomically reload all extension
 * registries with `/skills reload`.
 */
export async function* handleSkillsCommand(
  ctx: CommandContext,
  args: string[] = [],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  if (args[0]?.toLowerCase() === "reload") {
    const result = await refreshActivePlugins(ctx.cwd);
    const summary = result.summary;
    const lines = [
      `Extensions reloaded: ${summary.enabledPlugins} enabled, ${summary.disabledPlugins} disabled.`,
      `Skills ${summary.skills} · Commands ${summary.commands} · Agents ${summary.agents} · ` +
        `Styles ${summary.outputStyles} · Hooks ${summary.hooks} · MCP ${summary.mcpServers} · LSP ${summary.lspServers} · ` +
        `Errors ${summary.errors}`,
    ];
    if (result.mcpStarted.length > 0) lines.push(`MCP started: ${result.mcpStarted.join(", ")}`);
    if (result.mcpStopped.length > 0) lines.push(`MCP stopped: ${result.mcpStopped.join(", ")}`);
    if (summary.errors > 0) {
      lines.push(`${summary.errors} issue(s) detected; run /doctor for details.`);
    }
    yield { type: "command", kind: summary.errors > 0 ? "error" : "info", message: lines.join("\n") };
    return { handled: true };
  }

  if (args.length > 0) {
    yield {
      type: "command",
      kind: "error",
      message: `Unknown /skills subcommand: ${args[0]}. Try /skills or /skills reload.`,
    };
    return { handled: true };
  }

  const all = getAllUserInvocableSkills();
  if (all.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message:
        "Skills (0 loaded)\n\n" +
        "No skills found. Add a directory containing SKILL.md to:\n" +
        "  ~/.easy-agent/skills/<name>/SKILL.md   (user-wide)\n" +
        "  .easy-agent/skills/<name>/SKILL.md     (project-only)",
    };
    return { handled: true };
  }
  const lines = [`Skills (${all.length} loaded)`, ""];
  for (const skill of all) {
    const meta: string[] = [skill.source];
    if (skill.frontmatter.disableModelInvocation) meta.push("hidden-from-model");
    if (skill.frontmatter.paths) meta.push(`conditional: ${skill.frontmatter.paths.join(",")}`);
    if (skill.frontmatter.allowedTools.length > 0) {
      meta.push(`allowed-tools: ${skill.frontmatter.allowedTools.join(",")}`);
    }
    lines.push(`  /${skill.name} — ${skill.description}`);
    lines.push(`    ${meta.join(" · ")}`);
  }
  lines.push("", "Invoke a skill with /<name> [args], or let the model call it via the Skill tool.");
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * Handle `/agents` — read-only listing of every Agent definition the
 * loader picked up at startup, grouped by source. Text-only listing; there
 * is no interactive agents menu.
 *
 * The model only sees the agents in the system-prompt <system-reminder>;
 * this command is the human-side answer to "what sub-agent types are
 * available right now?"
 */
export async function* handleAgentsCommand(): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const all = getAllAgents();
  if (all.length === 0) {
    yield {
      type: "command",
      kind: "info",
      message:
        "Agents (0 loaded)\n\n" +
        "No agents registered. Built-ins should always be present — if you see\n" +
        "this, the bootstrap may have failed; check the startup logs.\n" +
        "Add custom agents under:\n" +
        "  ~/.easy-agent/agents/<name>.md   (user-wide)\n" +
        "  .easy-agent/agents/<name>.md     (project-only)",
    };
    return { handled: true };
  }

  // Group by source so a project override is visually adjacent to
  // (and shadowing) its built-in. Order: built-in → user → project.
  const SOURCE_ORDER: Record<string, number> = { "built-in": 0, user: 1, project: 2 };
  const sorted = [...all].sort((a, b) => {
    const cmp = (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
    if (cmp !== 0) return cmp;
    return a.agentType.localeCompare(b.agentType);
  });

  const lines = [`Agents (${all.length} loaded)`, ""];
  for (const agent of sorted) {
    const tags: string[] = [agent.source];
    if (agent.tools && agent.tools.length > 0) {
      tags.push(`tools: ${agent.tools.join(",")}`);
    } else {
      tags.push("tools: *");
    }
    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      tags.push(`disallowed: ${agent.disallowedTools.join(",")}`);
    }
    if (agent.model) tags.push(`model: ${agent.model}`);
    if (agent.maxTurns !== undefined) tags.push(`maxTurns: ${agent.maxTurns}`);
    if (agent.permissionMode) tags.push(`mode: ${agent.permissionMode}`);

    const desc = agent.whenToUse.length > 200 ? `${agent.whenToUse.slice(0, 197)}…` : agent.whenToUse;
    lines.push(`  ${agent.agentType} — ${desc}`);
    lines.push(`    ${tags.join(" · ")}`);
    if (agent.filePath) {
      lines.push(`    ${agent.filePath}`);
    }
  }
  lines.push(
    "",
    "Sub-agents are spawned by the model via the `Agent` tool —",
    "you cannot invoke them directly. The model picks `subagent_type` from",
    "the names listed above, based on the task.",
  );
  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/** Render the current user and project Hook configuration for `/hooks`. */
export async function* handleHooksCommand(ctx: CommandContext): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const report = await loadHooksDiagnosticReport(ctx.cwd);
  const lines: string[] = [];

  lines.push("Hooks configuration");
  lines.push("");
  if (report.globallyDisabled) {
    lines.push("⚠ EASY_AGENT_DISABLE_HOOKS is set — all hooks are disabled this session.");
    lines.push("");
  }
  lines.push(`User-scope file:    ${report.userPath}`);
  lines.push(`Project-scope file: ${report.projectPath}`);
  lines.push("");
  for (const error of report.errors) lines.push(`⚠ ${error}`);
  if (report.errors.length > 0) lines.push("");

  const totalHookCount = (scope: HooksSettings): number =>
    HOOK_EVENTS.reduce((sum, ev) => sum + (scope[ev] ?? []).reduce((s, g) => s + g.hooks.length, 0), 0);
  const userTotal = totalHookCount(report.userHooks);
  const projectTotal = totalHookCount(report.projectHooks);

  if (userTotal === 0 && projectTotal === 0) {
    lines.push("No hooks configured. To add one, edit the user or project file above:");
    lines.push("");
    lines.push("  {");
    lines.push('    "hooks": {');
    lines.push('      "PreToolUse": [');
    lines.push('        { "matcher": "Bash", "hooks": [');
    lines.push('          { "type": "command", "command": "./safety-check.sh", "timeout": 10 }');
    lines.push("        ] }");
    lines.push("      ]");
    lines.push("    }");
    lines.push("  }");
    lines.push("");
    lines.push("Six events are supported: " + HOOK_EVENTS.join(", "));
    lines.push("");
    lines.push("Hook contract:");
    lines.push("  - stdin = JSON event payload");
    lines.push("  - exit 0 + stdout text   → injected as additionalContext (for some events)");
    lines.push("  - exit 2 + stderr text   → block the action; stderr fed back to the model");
    lines.push("  - JSON stdout            → richer control (decision / permissionDecision / additionalContext)");
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  lines.push(`Loaded ${userTotal + projectTotal} hook command(s) — ${userTotal} user, ${projectTotal} project.`);
  lines.push("");

  const renderScope = (scopeLabel: string, scope: HooksSettings): void => {
    let anyForScope = false;
    for (const event of HOOK_EVENTS) {
      const groups = scope[event] ?? [];
      if (groups.length === 0) continue;
      if (!anyForScope) {
        lines.push(`[${scopeLabel}]`);
        anyForScope = true;
      }
      for (const group of groups) {
        const matcher = group.matcher && group.matcher !== "*" ? group.matcher : "*";
        lines.push(`  ${event}  matcher=${matcher}`);
        for (const hook of group.hooks) {
          const cmdPreview = hook.command.length > 80 ? `${hook.command.slice(0, 77)}...` : hook.command;
          lines.push(`    - $ ${cmdPreview}    (timeout: ${hook.timeout ?? 60}s)`);
        }
      }
    }
    if (anyForScope) lines.push("");
  };

  renderScope("user", report.userHooks);
  renderScope("project", report.projectHooks);

  lines.push("Order of execution: all user groups, then all project groups (in file order).");
  lines.push("Run results aggregate as: deny > ask > allow.");
  lines.push("Set EASY_AGENT_DISABLE_HOOKS=1 to disable every hook for one session.");

  // Re-cast HookEvent to satisfy the unused-import check after type
  // narrowing eliminates the value usage at runtime. (Compile-only;
  // no runtime cost.)
  void ({} as HookEvent);

  yield { type: "command", kind: "info", message: lines.join("\n") };
  return { handled: true };
}

/**
 * Handle the `/mcp` slash command family.
 *
 *   /mcp                       — list every configured server + status + tool count
 *   /mcp tools <name>          — show all tools exposed by one server
 *   /mcp reconnect <name>      — drop cache + retry connection
 *
 * The output is rendered as a system notice (info/error tone), never sent
 * to the model. A text-only listing is enough here; no TUI panel is needed.
 */
export async function* handleMcpCommand(args: string[]): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  const describeTransport = (config: ScopedMcpServerConfig): string => {
    if (config.type === "http") return `http: ${config.url}`;
    if (config.type === "sse") return `sse: ${config.url}`;
    return `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim();
  };

  const [sub, ...rest] = args;

  if (!sub) {
    const entries = getMcpRegistry();
    if (entries.length === 0) {
      yield {
        type: "command",
        kind: "info",
        message:
          "MCP Servers (0 configured)\n\n" +
          'No MCP servers configured. Add them under "mcpServers" in:\n' +
          "  ~/.easy-agent/settings.json   (user-wide)\n" +
          "  .easy-agent/settings.json      (project-only)",
      };
      return { handled: true };
    }
    const lines = [`MCP Servers (${entries.length} configured)`, ""];
    for (const { connection, tools } of entries) {
      const transport = describeTransport(connection.config);
      if (connection.type === "connected") {
        lines.push(`  ✓ ${connection.name}    connected   ${tools.length} tool(s)   (${transport})`);
      } else if (connection.type === "failed") {
        lines.push(`  ✗ ${connection.name}    failed      ${connection.error}`);
      } else if (connection.type === "pending") {
        const elapsedSec = Math.floor((Date.now() - connection.startedAt) / 1000);
        lines.push(`  … ${connection.name}    connecting  (${elapsedSec}s elapsed; ${transport})`);
      } else {
        lines.push(`  - ${connection.name}    disabled`);
      }
    }
    lines.push("", "Subcommands: /mcp tools <name> | /mcp reconnect <name>");
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  if (sub === "tools") {
    const target = rest[0];
    if (!target) {
      yield { type: "command", kind: "error", message: "Usage: /mcp tools <serverName>" };
      return { handled: true };
    }
    const entry = getMcpRegistryEntry(target);
    if (!entry) {
      yield { type: "command", kind: "error", message: `MCP server '${target}' is not configured.` };
      return { handled: true };
    }
    if (entry.connection.type !== "connected") {
      yield {
        type: "command",
        kind: "error",
        message: `MCP server '${target}' is ${entry.connection.type}; cannot list tools.`,
      };
      return { handled: true };
    }
    if (entry.tools.length === 0) {
      yield {
        type: "command",
        kind: "info",
        message: `MCP server '${target}' exposes no tools (server may not declare the 'tools' capability).`,
      };
      return { handled: true };
    }
    const lines = [`MCP tools from '${target}' (${entry.tools.length})`, ""];
    for (const tool of entry.tools) {
      const ro = tool.isReadOnly() ? "[ro]" : "    ";
      const desc = tool.description.replace(/\s+/g, " ").trim();
      const truncated = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
      lines.push(`  ${ro} ${tool.name}`);
      if (truncated) lines.push(`        ${truncated}`);
    }
    yield { type: "command", kind: "info", message: lines.join("\n") };
    return { handled: true };
  }

  if (sub === "reconnect") {
    const target = rest[0];
    if (!target) {
      yield { type: "command", kind: "error", message: "Usage: /mcp reconnect <serverName>" };
      return { handled: true };
    }
    const entry = getMcpRegistryEntry(target);
    if (!entry) {
      yield { type: "command", kind: "error", message: `MCP server '${target}' is not configured.` };
      return { handled: true };
    }
    try {
      const next = await reconnectMcpServer(target);
      if (!next) {
        yield {
          type: "command",
          kind: "error",
          message: `MCP server '${target}' was removed before reconnect completed.`,
        };
        return { handled: true };
      }
      if (next.type === "connected") {
        const newEntry = getMcpRegistryEntry(target);
        yield {
          type: "command",
          kind: "info",
          message: `MCP server '${target}' reconnected (${newEntry?.tools.length ?? 0} tool(s)).`,
        };
      } else if (next.type === "failed") {
        yield {
          type: "command",
          kind: "error",
          message: `MCP server '${target}' reconnect failed: ${next.error}`,
        };
      } else {
        yield {
          type: "command",
          kind: "info",
          message: `MCP server '${target}' is currently disabled.`,
        };
      }
    } catch (error) {
      yield {
        type: "command",
        kind: "error",
        message: `MCP server '${target}' reconnect threw: ${(error as Error).message}`,
      };
    }
    return { handled: true };
  }

  yield {
    type: "command",
    kind: "error",
    message: `Unknown /mcp subcommand: ${sub}. Try /mcp, /mcp tools <name>, or /mcp reconnect <name>.`,
  };
  return { handled: true };
}

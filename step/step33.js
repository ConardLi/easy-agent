/**
 * Step 33 - Built-in command completion
 *
 * Goal:
 * - centralize slash-command registration
 * - implement status, context, doctor, export, resume, diff, permissions, memory, copy
 * - keep /init as a prompt command that asks the model to draft AGENT.md
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Registry and dispatch
// -----------------------------------------------------------------------------

export class CommandRegistry {
  constructor(commands = []) {
    this.commands = new Map();
    commands.forEach((command) => this.register(command));
  }

  register(command) {
    this.commands.set(command.name, command);
    for (const alias of command.aliases || []) this.commands.set(alias, command);
  }

  list() {
    return [...new Set(this.commands.values())].sort((a, b) => a.name.localeCompare(b.name));
  }

  async dispatch(line, ctx) {
    const match = String(line).trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const command = this.commands.get(match[1]);
    if (!command) return { handled: true, output: `Unknown command: /${match[1]}` };

    return { handled: true, ...(await command.run(match[2] || "", ctx)) };
  }
}

export function createDefaultRegistry() {
  return new CommandRegistry([
    initCommand,
    statusCommand,
    contextCommand,
    doctorCommand,
    exportCommand,
    resumeCommand,
    diffCommand,
    permissionsCommand,
    memoryCommand,
    copyCommand,
  ]);
}

// -----------------------------------------------------------------------------
// 2. Prompt command
// -----------------------------------------------------------------------------

export const initCommand = {
  name: "init",
  description: "Draft AGENT.md for the current project",
  async run(_args, ctx) {
    const tree = await ctx.inspectProject();
    return {
      prompt: [
        "Analyze this repository and draft an AGENT.md file.",
        "Focus on commands, architecture, conventions, and safety notes.",
        "",
        tree,
      ].join("\n"),
    };
  },
};

// -----------------------------------------------------------------------------
// 3. Read-only diagnostics
// -----------------------------------------------------------------------------

export const statusCommand = {
  name: "status",
  async run(_args, ctx) {
    return {
      output: [
        `model: ${ctx.model}`,
        `provider: ${ctx.provider}`,
        `mode: ${ctx.permissionMode}`,
        `session: ${ctx.session.id}`,
        `cwd: ${ctx.cwd}`,
        `tools: ${ctx.tools.join(", ")}`,
      ].join("\n"),
    };
  },
};

export const contextCommand = {
  name: "context",
  async run(_args, ctx) {
    const total = Object.values(ctx.context).reduce((sum, value) => sum + value, 0);
    const lines = Object.entries(ctx.context).map(([name, tokens]) => {
      const width = Math.round((tokens / Math.max(total, 1)) * 20);
      return `${name.padEnd(10)} ${"#".repeat(width).padEnd(20)} ${tokens}`;
    });
    return { output: [`total ${total} tokens`, ...lines].join("\n") };
  },
};

export const doctorCommand = {
  name: "doctor",
  async run(_args, ctx) {
    const checks = [
      ["model profile", Boolean(ctx.model)],
      ["api key", Boolean(ctx.apiKey)],
      ["session store", await ctx.exists(ctx.session.dir)],
      ["mcp servers", ctx.mcpServers.length > 0],
    ];
    return { output: checks.map(([name, ok]) => `${ok ? "ok" : "warn"} ${name}`).join("\n") };
  },
};

// -----------------------------------------------------------------------------
// 4. Session commands
// -----------------------------------------------------------------------------

export const exportCommand = {
  name: "export",
  async run(args, ctx) {
    const target = args.trim() || path.join(ctx.cwd, `${ctx.session.id}.md`);
    const markdown = ctx.session.messages.map((m) => `## ${m.role}\n\n${m.content}`).join("\n\n");
    await fs.writeFile(target, markdown, "utf8");
    return { output: `Exported ${ctx.session.messages.length} messages to ${target}` };
  },
};

export const resumeCommand = {
  name: "resume",
  aliases: ["continue"],
  async run(args, ctx) {
    const target = args.trim() || ctx.sessions.at(-1)?.id;
    const session = ctx.sessions.find((item) => item.id === target || item.id.startsWith(target));
    if (!session) return { output: "No matching session." };
    ctx.session = session;
    return { output: `Resumed ${session.id}` };
  },
};

export const diffCommand = {
  name: "diff",
  async run(args, ctx) {
    const count = Number(args.trim() || 1);
    return { output: ctx.fileHistory.diffLastTurns(count) };
  },
};

export const copyCommand = {
  name: "copy",
  async run(args, ctx) {
    const n = Number(args.trim() || 1);
    const message = ctx.session.messages.at(-n);
    if (!message) return { output: "No message to copy." };
    await ctx.clipboard.writeText(message.content);
    return { output: `Copied ${message.role} message.` };
  },
};

// -----------------------------------------------------------------------------
// 5. Editable runtime state
// -----------------------------------------------------------------------------

export const permissionsCommand = {
  name: "permissions",
  aliases: ["allowed-tools"],
  async run(args, ctx) {
    const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const rule = rest.join(" ");

    if (action === "allow" && rule) ctx.permissions.allow.push(rule);
    if (action === "deny" && rule) ctx.permissions.deny.push(rule);
    if (action === "remove" && rule) {
      ctx.permissions.allow = ctx.permissions.allow.filter((item) => item !== rule);
      ctx.permissions.deny = ctx.permissions.deny.filter((item) => item !== rule);
    }

    return {
      output: [
        `allow: ${ctx.permissions.allow.join(", ") || "-"}`,
        `deny: ${ctx.permissions.deny.join(", ") || "-"}`,
      ].join("\n"),
    };
  },
};

export const memoryCommand = {
  name: "memory",
  async run(args, ctx) {
    const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (action === "edit") {
      const index = Number(rest[0]) - 1;
      if (!ctx.memory[index]) return { output: "No matching memory." };
      ctx.memory[index] = rest.slice(1).join(" ") || ctx.memory[index];
    }
    return { output: ctx.memory.map((item, i) => `${i + 1}. ${item}`).join("\n") || "No memory." };
  },
};

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep33() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step33-"));
  const registry = createDefaultRegistry();
  const ctx = {
    cwd,
    model: "gpt",
    provider: "openai-chat",
    apiKey: "set",
    permissionMode: "ask",
    tools: ["Read", "Edit", "Bash"],
    mcpServers: [],
    context: { system: 1200, tools: 800, history: 2600, remaining: 5400 },
    permissions: { allow: ["Read(*)"], deny: [] },
    memory: ["Use npm for this project."],
    sessions: [
      { id: "old-session", dir: cwd, messages: [{ role: "assistant", content: "old answer" }] },
      { id: "current-session", dir: cwd, messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world" }] },
    ],
    async inspectProject() {
      return "package.json\nsrc/\nREADME.md";
    },
    async exists(filePath) {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    fileHistory: {
      diffLastTurns(count) {
        return `diff for last ${count} turn(s)`;
      },
    },
    clipboard: {
      text: "",
      async writeText(text) {
        this.text = text;
      },
    },
  };
  ctx.session = ctx.sessions[1];

  const status = await registry.dispatch("/status", ctx);
  const init = await registry.dispatch("/init", ctx);
  const permissions = await registry.dispatch("/permissions deny Bash(rm -rf *)", ctx);
  const copy = await registry.dispatch("/copy", ctx);
  const exported = path.join(cwd, "session.md");
  await registry.dispatch(`/export ${exported}`, ctx);

  return {
    commands: registry.list().length,
    status: status.output.split("\n")[0],
    initPrompt: init.prompt.includes("draft an AGENT.md file"),
    permissions: permissions.output,
    copied: ctx.clipboard.text,
    exported: await fs.readFile(exported, "utf8"),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoStep33().then((result) => console.log(JSON.stringify(result, null, 2)));
}

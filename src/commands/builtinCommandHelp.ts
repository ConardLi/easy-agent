/**
 * Built-in slash commands as listed to the user. `eagent --help` and the REPL
 * `/help` panel both render this list, so the two stay in step. Every name in
 * `BUILTIN_COMMAND_NAMES` appears here, either as an entry or as an alias in
 * an entry's description.
 */

export interface BuiltinCommandHelp {
  usage: string;
  description: string;
}

export const BUILTIN_COMMAND_HELP: readonly BuiltinCommandHelp[] = [
  { usage: "/help", description: "Show available commands" },
  { usage: "/clear", description: "Clear conversation history" },
  { usage: "/config [list|get|set]", description: "Inspect or change settings (--user/--project/--local)" },
  { usage: "/cost", description: "Show session token usage" },
  { usage: "/model [name|list|default]", description: "Inspect or override the session model" },
  { usage: "/mode [default|plan|auto]", description: "Inspect or switch permission mode" },
  { usage: "/think [on|off|<budget>]", description: "Control extended thinking" },
  { usage: "/effort [low|medium|high|max]", description: "Set reasoning effort (Anthropic)" },
  { usage: "/tasks [task|todo|reset]", description: "Switch task system or reset the task graph" },
  { usage: "/mcp [tools|reconnect <n>]", description: "Inspect or reconnect MCP servers" },
  {
    usage: "/plugin [install|enable|disable|marketplace ...]",
    description: "Manage plugins (alias: /plugins); /marketplace is /plugin marketplace",
  },
  { usage: "/reload-plugins", description: "Reload plugins and extension registries" },
  { usage: "/skills [reload]", description: "List loaded skills or reload extensions" },
  { usage: "/<skill-name> [args]", description: "Run a skill as a chat turn" },
  { usage: "/<command> [args]", description: "Run a user-defined command (.easy-agent/commands)" },
  { usage: "/output-style [name]", description: "Inspect or switch the answer style" },
  { usage: "/agents", description: "List built-in + custom sub-agent definitions" },
  { usage: "/hooks", description: "Show configured lifecycle hooks (alias: /hook)" },
  { usage: "/history", description: "Show saved sessions for this project" },
  { usage: "/compact", description: "Compact conversation context" },
  { usage: "/rewind [n]", description: "Restore files to a previous turn (alias: /checkpoint)" },
  { usage: "/status", description: "Snapshot of the current session config" },
  { usage: "/context", description: "Visualize context window usage by category" },
  { usage: "/doctor", description: "Run an environment health check" },
  { usage: "/copy [n]", description: "Copy an assistant reply to the clipboard" },
  { usage: "/export [file]", description: "Export the conversation to Markdown" },
  { usage: "/resume [n|id]", description: "List and switch to a saved session (alias: /continue)" },
  { usage: "/diff [n]", description: "Show uncommitted git changes + recent agent edits" },
  { usage: "/init", description: "Analyze the repo and draft an AGENT.md (runs a model turn)" },
  {
    usage: "/permissions [allow|deny|remove <rule>]",
    description: "Manage allow/deny rules by layer (alias: /allowed-tools)",
  },
  { usage: "/memory [edit <n>]", description: "List/edit AGENT.md + project memory files in $EDITOR" },
  { usage: "/exit | /quit | /bye", description: "Exit session" },
];

const USAGE_COLUMN = 28;

/** Two-column rows for `eagent --help`; a long usage puts its description on the next line. */
export function formatBuiltinCommandHelpColumns(indent = "  "): string {
  return BUILTIN_COMMAND_HELP.map(({ usage, description }) =>
    usage.length < USAGE_COLUMN
      ? `${indent}${usage.padEnd(USAGE_COLUMN)}${description}`
      : `${indent}${usage}\n${indent}${" ".repeat(USAGE_COLUMN)}${description}`,
  ).join("\n");
}

/** `usage — description` lines for the REPL `/help` panel. */
export function formatBuiltinCommandHelpLines(): string {
  return BUILTIN_COMMAND_HELP.map(({ usage, description }) => `${usage} — ${description}`).join("\n");
}

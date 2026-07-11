/**
 * The set of slash-command names handled INTERNALLY by the QueryEngine
 * (`handleCommand`) or the UI (exit). These are reserved: a user-defined
 * command or skill with one of these names must NOT shadow the built-in,
 * otherwise `/help`, `/output-style`, etc. would silently stop working
 * once a user drops a same-named file into ~/.easy-agent/commands/.
 *
 * Both the engine (when deciding whether a `/x` is a user command) and the
 * UI (when deciding whether `/x` should trigger the LLM) consult this set,
 * so the two layers agree on dispatch.
 */
export const BUILTIN_COMMAND_NAMES = new Set<string>([
  "help",
  "clear",
  "config",
  "cost",
  "model",
  "mode",
  "tasks",
  "mcp",
  "skills",
  "agents",
  "hooks",
  "hook",
  "history",
  "compact",
  "rewind",
  "checkpoint",
  "status",
  "context",
  "doctor",
  "copy",
  "export",
  "resume",
  "continue",
  "diff",
  "permissions",
  "allowed-tools",
  "allowed_tools",
  "memory",
  "think",
  "effort",
  "init",
  "exit",
  "quit",
  "bye",
  "output-style",
  "output_style",
]);

/** Case-insensitive membership check against the reserved built-in names. */
export function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_COMMAND_NAMES.has(name.toLowerCase());
}

/**
 * Built-in commands of the `prompt` kind: instead of producing a local panel,
 * they expand into a prompt that runs a normal model turn (mirrors Claude
 * Code's `type: 'prompt'` commands, e.g. `/init`). They must be recognised as
 * LLM-triggering by the UI and routed through prompt expansion by the engine.
 */
export const BUILTIN_PROMPT_COMMAND_NAMES = new Set<string>(["init"]);

/** Case-insensitive membership check for built-in `prompt` commands. */
export function isBuiltinPromptCommand(name: string): boolean {
  return BUILTIN_PROMPT_COMMAND_NAMES.has(name.toLowerCase());
}

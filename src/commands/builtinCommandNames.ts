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

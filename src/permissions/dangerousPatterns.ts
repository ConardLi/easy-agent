/**
 * Auto Mode dangerous-permission patterns.
 *
 * Reference: claude-code-source-code/src/utils/permissions/dangerousPatterns.ts
 * (`isDangerousClassifierPermission` / `isDangerousBashPermission` /
 *  `isDangerousTaskPermission`).
 *
 * Some allow rules, if honored in Auto Mode, would let the agent bypass the
 * AI classifier entirely — e.g. `Bash(node:*)` lets it run arbitrary code via
 * an interpreter, and `Agent(*)` hands work to a sub-agent without per-action
 * review. In Auto Mode these allow rules are NOT honored; the matching action
 * falls through to the classifier instead.
 *
 * Design note: source physically strips these rules from the context on
 * entering auto mode and restores them on exit. Easy Agent instead filters
 * them at decision time (`checkPermission` receives the rule set as params on
 * every call), so there is no mutate/restore state machine to keep in sync —
 * the full rule set automatically applies again the moment the mode leaves
 * `auto`. Same security guarantee, no cross-module state.
 */

/**
 * Shell interpreters / eval-style commands that can execute arbitrary code.
 * An allow rule whose Bash pattern leads with one of these is dangerous.
 */
const INTERPRETER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "fish",
  "dash",
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python2",
  "python3",
  "ruby",
  "perl",
  "php",
  "eval",
  "exec",
  "source",
  "env",
  "xargs",
]);

/** Parse a rule like `Bash(node *)` into `{ toolName, pattern }`. */
function parseRule(rule: string): { toolName: string; pattern: string | null } {
  const trimmed = rule.trim();
  const match = trimmed.match(/^([A-Za-z]+)\((.*)\)$/);
  if (!match) {
    return { toolName: trimmed, pattern: null };
  }
  return { toolName: match[1], pattern: match[2].trim() };
}

/** Leading command word of a Bash pattern, with any trailing glob stripped. */
function leadingCommand(pattern: string): string {
  const firstToken = pattern.split(/\s+/)[0] ?? "";
  // Strip a trailing glob (`node*` → `node`) and any path prefix (`/usr/bin/node` → `node`).
  const noGlob = firstToken.replace(/\*+$/, "");
  const base = noGlob.split("/").pop() ?? noGlob;
  return base.toLowerCase();
}

/**
 * True if honoring this allow rule in Auto Mode would let the agent bypass the
 * classifier. Only meaningful for ALLOW rules — deny rules are always honored.
 */
export function isDangerousAutoModeRule(rule: string): boolean {
  const { toolName, pattern } = parseRule(rule);

  // Any Agent allow rule lets a sub-agent run without per-action classification.
  if (toolName === "Agent") return true;

  if (toolName === "Bash") {
    // Bare `Bash` (no pattern) allows every shell command.
    if (pattern === null) return true;
    // `Bash(*)` allows every shell command.
    if (pattern === "" || pattern === "*") return true;
    return INTERPRETER_COMMANDS.has(leadingCommand(pattern));
  }

  return false;
}

/** Filter out dangerous allow rules, leaving the safe ones intact. */
export function stripDangerousAllowRules(rules: string[]): string[] {
  return rules.filter((rule) => !isDangerousAutoModeRule(rule));
}

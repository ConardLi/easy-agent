/**
 * Format the available-agents discovery listing into a <system-reminder>
 * block. Mirrors the budget-aware formatter in services/skills/budget.ts
 * but simpler — agent counts are small (typically < 10), so we don't need
 * the three-tier degradation the skills formatter has.
 *
 * The block goes into the dynamic section of the system prompt so the
 * model knows what `subagent_type` values it can pass to the Agent tool,
 * and — equally important — what the on-disk format is when the user
 * asks the model to define a brand-new sub-agent. Without that second
 * half, models tend to fall back to `.yaml` / `.json` from their training
 * data and the loader silently ignores the file.
 */

import type { AgentDefinition } from "./types.js";

const MAX_DESC_CHARS = 220;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The "creation" block — appended to every reminder so the model has the
 * format spec on hand the moment a user asks "make me a new sub-agent".
 *
 * Why bake it into the same reminder instead of a separate prompt section:
 *   The agent listing already lives in dynamic prompt space and reads
 *   right above this. Splitting them would force the model to cross-
 *   reference two distant blocks. Keeping definition + creation in one
 *   reminder also means a single cache bust on agent reload, not two.
 */
const CREATION_GUIDANCE = [
  "",
  "Defining a new sub-agent (when the user asks you to create / scaffold one):",
  "- File path: `<cwd>/.easy-agent/agents/<name>.md` (project-scope, default)",
  "                or `~/.easy-agent/agents/<name>.md` (user-scope, shared across projects)",
  "- File extension MUST be `.md` — `.yaml` / `.json` / `.txt` files are ignored by the loader.",
  "- Format: a Markdown file with a YAML frontmatter header followed by the system prompt body.",
  "- Required frontmatter fields: `name` (sub-agent identifier), `description` (whenToUse text shown to the dispatching agent).",
  "- Optional frontmatter fields: `tools` (CSV or YAML list — explicit allow-list; omit for wildcard),",
  "  `disallowedTools` (CSV or YAML list — strip from the wildcard pool, e.g. Write/Edit for read-only agents),",
  "  `model` (override; falls back to parent's), `maxTurns` (positive integer), `permissionMode` (default | plan | auto).",
  "- The Markdown body BELOW the frontmatter IS the sub-agent's system prompt — no extra wrapping needed.",
  "- After writing, the user must restart easy-agent for the registry to pick the new file up.",
  "",
  "Template — copy verbatim and edit:",
  "```markdown",
  "---",
  "name: \"my-agent\"",
  "description: \"One-sentence whenToUse — the dispatching agent reads this to decide whether to delegate.\"",
  "tools: \"Read,Grep,Glob\"",
  "disallowedTools: \"Write,Edit\"",
  "model: \"claude-sonnet-4-5\"",
  "maxTurns: 20",
  "permissionMode: \"default\"",
  "---",
  "You are <role>. Your job is <one-sentence mission>.",
  "",
  "<Detailed instructions, output format, constraints — same shape as the built-in",
  "general-purpose / Explore prompts you can read at src/agents/builtIn/.>",
  "```",
].join("\n");

/**
 * Render the "available sub-agents" system-reminder block. Returns an
 * empty string when there are no agents loaded (so callers can
 * unconditionally concatenate without producing trailing whitespace) —
 * in practice this is dead code since the registry always ships the
 * two built-ins, but the contract is preserved for callers and tests.
 */
export function formatAgentsSystemReminder(agents: AgentDefinition[]): string {
  if (agents.length === 0) return "";

  // Sort built-ins to the top and otherwise alphabetically — gives the
  // model a stable, predictable listing across turns regardless of the
  // order custom agent files were loaded.
  const sorted = [...agents].sort((a, b) => {
    if (a.source === "built-in" && b.source !== "built-in") return -1;
    if (a.source !== "built-in" && b.source === "built-in") return 1;
    return a.agentType.localeCompare(b.agentType);
  });

  const lines = sorted.map((a) => {
    const tag =
      a.source === "built-in"
        ? "built-in"
        : a.source === "project"
          ? "project"
          : "user";
    return `- ${a.agentType} [${tag}]: ${truncate(a.whenToUse, MAX_DESC_CHARS)}`;
  });

  return [
    "<system-reminder>",
    "Available sub-agents you can invoke via the `Agent` tool. Each sub-agent runs in its own context window with its own tool set and returns a concise summary.",
    "Call `Agent(prompt=\"...\", description=\"3-5 word task name\", subagent_type=\"<name>\")` to delegate a focused subtask.",
    "Use sub-agents to keep the main conversation context clean — search-heavy or read-heavy work is a good fit. Do not delegate trivial single-step tasks.",
    "Sub-agents do NOT see the main conversation history, so the `prompt` must be self-contained.",
    "",
    // Foreground vs background discipline — copied almost verbatim from
    // source's `claude-code-source-code/src/tools/AgentTool/prompt.ts:262-264`
    // because the rule is too easy for the model to forget mid-conversation:
    //   - polling burns tokens and locks the user out behind a spinner;
    //   - "end your response" is one of TWO equally-valid options, not the
    //     only one — the main agent can still spawn more parallel
    //     background agents or do unrelated work.
    "Foreground vs background:",
    "- Use foreground (default) when you need the agent's results before you can proceed — e.g., a research agent whose findings inform your next steps.",
    "- Use `run_in_background: true` when the user has independent work for you to do in parallel, or when the user explicitly asks for a background task.",
    "- After launching a background sub-agent you will be notified automatically when it completes via a `<task-notification>` user message — do NOT sleep, poll, or proactively check on its progress (no Bash sleeps, no Read on the output file, no `tail -f`).",
    "- You CAN continue with other unrelated work while a background sub-agent is running, including launching MORE background sub-agents for genuinely independent subtasks. The main loop will not block on them.",
    "- Or you can simply tell the user what you launched and end your response — the system will resume the conversation automatically when the sub-agent finishes.",
    "",
    ...lines,
    CREATION_GUIDANCE,
    "</system-reminder>",
  ].join("\n");
}

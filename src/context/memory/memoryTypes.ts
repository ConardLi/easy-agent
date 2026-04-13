export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryFrontmatter {
  name: string;
  description: string;
  type: MemoryType;
}

export interface MemoryEntry {
  fileName: string;
  filePath: string;
  title: string;
  hook: string;
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && MEMORY_TYPES.includes(value as MemoryType);
}

export function buildMemoryTypeGuidance(): string[] {
  return [
    "## Types of memory",
    "",
    "You can store four kinds of durable project memory:",
    "",
    "- user: stable details about the user's role, preferences, strengths, or goals that should change how you collaborate.",
    "  - Save when: you learn something durable about how to explain, prioritize, or tailor work for this user.",
    "  - Use when: the same technical answer should be framed differently for this specific user.",
    "",
    "- feedback: guidance from the user about what to do, avoid, keep doing, or how to judge success.",
    "  - Save when: the user corrects your approach or confirms a non-obvious approach was right.",
    "  - Use when: choosing how to execute similar work in future conversations.",
    "  - Structure: lead with the rule, then include Why and How to apply when possible.",
    "",
    "- project: non-derivable context about goals, constraints, incidents, deadlines, ownership, or ongoing initiatives.",
    "  - Save when: you learn who is doing what, why it matters, or by when.",
    "  - Use when: this context should change your recommendations or prioritization.",
    "  - Structure: lead with the fact or decision, then include Why and How to apply when possible.",
    "",
    "- reference: pointers to external systems, dashboards, trackers, or documents that matter for future work.",
    "  - Save when: you learn where up-to-date information lives outside the repository.",
    "  - Use when: the user references that external system or the work clearly depends on it.",
  ];
}

export function buildMemoryAccessGuidance(): string[] {
  return [
    "## When to access memory",
    "- Access memory when it seems relevant or the user references prior work or prior conversations.",
    "- Use the MEMORY.md index as a map. If an indexed memory file looks relevant, proactively read that file before relying on it instead of waiting for the system to inline it for you.",
    "- You MUST access memory when the user explicitly asks you to check, recall, or remember.",
    "- If the user says to ignore memory, proceed as if project memory were empty. Do not apply, cite, compare against, or mention remembered content.",
  ];
}

export function buildMemoryValidationGuidance(): string[] {
  return [
    "## Before relying on memory",
    "Project memory stores only facts that cannot be derived reliably from the current repo state.",
    "Memory is context about what was true when it was written, not proof that it is still true now.",
    "Before relying on a memory that names a file path, check that the file still exists.",
    "Before relying on a memory that names a function, flag, or symbol, grep or read the current code to confirm it still exists.",
    "If the user is about to act on a remembered fact, verify it first. If memory conflicts with the current repo state, trust the current state and update or remove the stale memory later.",
  ];
}

export function buildMemoryExclusionGuidance(): string[] {
  return [
    "## What not to save in memory",
    "- Do not save code structure, file contents, architecture, or conventions that can be re-read from the workspace.",
    "- Do not save git history, recent diffs, or who-changed-what when git is the authoritative source.",
    "- Do not save debugging recipes or fix steps that are already reflected in the code or commits.",
    "- Do not save ephemeral task status, temporary plans, or current-conversation working notes.",
    "- Do not turn memory into an activity log. If the user asks you to remember a summary, keep only the surprising, non-obvious, future-useful part.",
  ];
}

export function buildMemoryPersistenceBoundaryGuidance(): string[] {
  return [
    "## Memory versus other persistence",
    "Use memory for information that should help in future conversations, not just this one.",
    "If information is only about the current task plan or in-progress execution state, keep it in the conversation or task tracking instead of memory.",
  ];
}

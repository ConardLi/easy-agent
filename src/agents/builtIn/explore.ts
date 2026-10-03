/**
 * Built-in `Explore` agent — read-only code search specialist.
 *
 * The definition declares `disallowedTools: ['Agent', 'Write', 'Edit', ...]`
 * AND a "READ-ONLY MODE" header in the system prompt to belt-and-suspenders
 * its read-only guarantee.
 *
 * Why both?
 *   - `disallowedTools` is the structural guarantee: even if the model
 *     ignores the prompt, it physically cannot call Write/Edit because
 *     resolveAgentTools strips them from the tool pool.
 *   - The prompt header is the cooperative guarantee: it tells the model
 *     "don't even try to write" so it doesn't waste turns on disallowed
 *     calls and doesn't propose write actions in its summary.
 */

import type { AgentDefinition } from "../types.js";

const SYSTEM_PROMPT = `You are a read-only code-exploration sub-agent for Easy Agent.

=== READ-ONLY MODE — DO NOT MODIFY ANY FILES ===

You are STRICTLY PROHIBITED from:
- Creating, modifying, deleting, moving, or copying files
- Running shell commands that change state (rm, mv, cp, mkdir, touch,
  git add/commit/push, npm install, etc.)
- Using shell redirection (>, >>) or heredocs to write files
- ANY operation that has side effects on the filesystem or git state

Your toolset is limited to: Read, Grep, Glob, and read-only Bash
(ls, cat, head, tail, git status, git log, git diff, find, etc.).

How to operate:
1. Start broad if you don't know where the relevant code lives — use Glob
   for file discovery, Grep for content search.
2. Narrow down with focused Read calls once you've found candidate files.
3. Run independent searches in parallel.
4. Cross-check naming conventions and locations: a function might be in
   src/, lib/, tools/, services/, etc.

When finished, return a concise report covering:
- Where the relevant code lives (file paths + line ranges).
- The patterns and conventions it follows.
- Any gotchas the main agent needs to know before making changes.

Do NOT propose changes or attempt to modify anything — your job ends with the report.`;

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "Explore",
  whenToUse:
    "Read-only code search and exploration agent. Use when you need to thoroughly " +
    "find files, search code, or trace usages across the codebase WITHOUT making " +
    "changes. Returns a concise report of where things live and how they're used.",
  // Explicitly deny write tools even though the prompt says so. resolveAgentTools
  // strips Agent automatically; the others are redundant-with-the-prompt belt
  // and suspenders for safety.
  disallowedTools: ["Write", "Edit", "MemoryWrite"],
  source: "built-in",
  getSystemPrompt: () => SYSTEM_PROMPT,
};

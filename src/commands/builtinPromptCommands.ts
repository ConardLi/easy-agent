/**
 * Built-in `prompt`-type slash commands.
 *
 * Unlike local commands (handled by `QueryEngine.handleCommand`, which yield a
 * panel and return), a prompt command expands into a prompt and runs one normal
 * model turn — the model does the work (e.g. analyse the repo and write
 * `AGENT.md`). This mirrors Claude Code's `commands/init.ts` (`type: 'prompt'`).
 *
 * The engine consumes these via `tryExpandBuiltinPromptCommand`: the matched
 * command name is recorded in the transcript as a hidden marker (so the bubble
 * shows `/init` rather than the multi-paragraph prompt body), and the prompt
 * text is fed into the regular agentic loop.
 */

import { isBuiltinPromptCommand } from "./builtinCommandNames.js";

export interface BuiltinPromptExpansion {
  /** Canonical command name, e.g. "init". */
  name: string;
  /**
   * Visible command bubble. Uses the `<command-message>`/`<command-name>` XML
   * tags that ConversationView parses to render a styled "❯ /init" bubble
   * (same format as skills and user commands).
   */
  markerContent: string;
  /**
   * Hidden, model-only prompt. Prefixed with `[command_invocation:<name>]\n`
   * so ConversationView filters it from the human view while the model still
   * receives the full expanded prompt.
   */
  bodyText: string;
}

const INIT_PROMPT = `Analyze this codebase and create (or improve) an AGENT.md file that will be given to future instances of this agent to operate in this repository.

Keep this fast and cheap — do NOT read the whole repository. Follow this exact two-step process:

## Step 1: Survey the codebase with ONE sub-agent

Launch a single sub-agent with the Agent tool (subagent_type: "Explore", or "general-purpose" if Explore is unavailable) to survey the repo. This keeps the file contents out of the main context. Give it a self-contained prompt instructing it to read ONLY these key files (skip whatever doesn't exist) and report back a concise summary:

- Manifest / dependency files: package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, build.gradle, Gemfile, etc.
- README.md (and any top-level docs it points to)
- Build / lint / format / test config: Makefile, justfile, tsconfig.json, .eslintrc*, ruff.toml, .golangci.yml, CI config under .github/workflows, etc.
- Existing AI-assistant config: AGENT.md, AGENTS.md, CLAUDE.md, .cursor/rules/ or .cursorrules, .github/copilot-instructions.md, .mcp.json
- Just enough of the source tree (top-level directories only) to understand the high-level architecture

Ask the sub-agent to return: build/test/lint commands (especially non-standard ones), languages/frameworks/package manager, the big-picture architecture, and any non-obvious gotchas. Tell it NOT to enumerate every file or read source files exhaustively.

## Step 2: Write AGENT.md from the survey

Using the sub-agent's summary, write a concise AGENT.md at the repository root. Every line must earn its place — if removing a line wouldn't cause the agent to make a mistake, cut it.

Include:
1. Commands that are commonly used and that the agent could NOT guess (non-standard build/lint/test scripts, flags, how to run a single test).
2. High-level architecture that requires reading multiple files to grasp — the "big picture", not a file-by-file listing.
3. Important parts of any existing README or AI-assistant config (Cursor/Copilot rules) found in Step 1.

Exclude:
- File-by-file structure or component lists (the agent can discover these by reading the code).
- Generic best practices ("write clean code", "handle errors", "never commit secrets").
- Obvious commands derivable from manifest files (plain "npm test", "cargo test", "pytest").
- Made-up sections like "Common Development Tasks" or "Tips for Development" unless they came from files you actually read.

Notes:
- If an AGENT.md already exists, read it first and propose targeted improvements as a diff instead of silently overwriting it.
- Be specific: "Use 2-space indentation in TypeScript" beats "format code properly".
- Prefix the file with exactly:

\`\`\`
# AGENT.md

This file provides guidance to AI agents when working with code in this repository.
\`\`\``;

const PROMPTS: Record<string, string> = {
  init: INIT_PROMPT,
};

/**
 * If `input` is a built-in prompt command (e.g. `/init`), return its expansion;
 * otherwise `null`. Extra arguments after the command name are appended to the
 * prompt so callers can pass instructions (e.g. `/init focus on the CLI`).
 */
export function tryExpandBuiltinPromptCommand(
  input: string,
): BuiltinPromptExpansion | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const rawName = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();
  const name = rawName.toLowerCase();

  if (!isBuiltinPromptCommand(name)) return null;
  const base = PROMPTS[name];
  if (!base) return null;

  const prompt = args ? `${base}\n\nAdditional instructions: ${args}` : base;

  const markerLines = [
    `<command-message>${name}</command-message>`,
    `<command-name>/${name}</command-name>`,
  ];
  if (args) {
    markerLines.push(`<command-args>${args}</command-args>`);
  }

  return {
    name,
    markerContent: markerLines.join("\n"),
    bodyText: `[command_invocation:${name}]\n${prompt}`,
  };
}

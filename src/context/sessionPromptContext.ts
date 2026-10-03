/**
 * Session-stable system prompt.
 *
 * Providers cache the request prefix (tools, system prompt, then messages)
 * and only reuse it while it stays byte-identical. Rebuilding the system
 * prompt every turn, with a clock value or a fresh `git status` in it, makes
 * every new user message re-process the whole conversation at full price.
 *
 * This module builds the system prompt once per session and keeps it fixed:
 *
 *   - The environment section (cwd, date, OS, git) is a snapshot taken when
 *     the prompt is built. The date has day precision; git is labelled as a
 *     session-start snapshot.
 *   - The other dynamic sections (output style, language, AGENT.md, memory
 *     index, skills, agents, team) are re-read every turn and compared with
 *     what the model last saw. Changed or removed sections are reported in a
 *     context update that the caller appends to the conversation tail, so the
 *     cached prefix stays intact.
 *   - A new calendar day is announced the same way.
 *   - A change to the static block (an output style that drops the coding
 *     instructions) rebuilds the prompt, because that block cannot be patched
 *     from the tail.
 *
 * `reset()` drops the snapshot; the next turn builds a fresh prompt. Callers
 * reset after /clear, compaction, and session restore, when the conversation
 * prefix is rebuilt anyway and earlier context updates may be gone.
 */

import { CONTEXT_UPDATE_MARKER } from "../constants/systemPromptMarkers.js";
import { shouldIgnoreMemory } from "./memory/memdir.js";
import {
  assembleSystemPrompt,
  buildStaticSystemParts,
  collectDynamicSections,
  getLocalDateString,
  getRuntimeEnvironmentContext,
  type PromptSection,
  type PromptSectionName,
  type RuntimeEnvironmentContext,
} from "./systemPrompt.js";

export { CONTEXT_UPDATE_MARKER };

const SECTION_TITLES: Record<PromptSectionName, string> = {
  output_style: "Output style",
  language: "Response language",
  environment: "Environment",
  agent_md: "Project memory (AGENT.md)",
  memory: "Memory",
  session_instructions: "Session instructions",
  skills: "Available skills",
  agents: "Available sub-agents",
  team: "Agent team",
};

export interface PreparedTurnContext {
  /** System prompt parts for this turn's requests. */
  systemParts: string[];
  /** Context update to append before the user's message, or null when nothing changed. */
  update: string | null;
}

export interface SessionPromptContext {
  /** Advance to a new user turn: returns the system prompt and any context update. */
  prepareTurn(options?: { userQuery?: string }): Promise<PreparedTurnContext>;
  /** The system prompt the next request would use, without advancing tracked state. */
  peekSystemParts(): Promise<string[]>;
  /** Drop the snapshot so the next turn builds a fresh system prompt. */
  reset(): void;
}

interface Snapshot {
  environment: RuntimeEnvironmentContext;
  staticParts: string[];
  systemParts: string[];
  /** Section text as the model last saw it, from the prompt or a later update. */
  seen: Map<PromptSectionName, string>;
  /** Last date the model was told about. */
  seenDate: string;
}

export interface SessionPromptContextOptions {
  cwd: string;
  additionalInstructions?: string;
  now?: () => Date;
}

export function createSessionPromptContext(options: SessionPromptContextOptions): SessionPromptContext {
  const now = options.now ?? (() => new Date());
  let snapshot: Snapshot | null = null;

  const collect = (environment: RuntimeEnvironmentContext): Promise<PromptSection[]> =>
    collectDynamicSections({
      cwd: options.cwd,
      environment,
      additionalInstructions: options.additionalInstructions,
    });

  async function build(): Promise<Snapshot> {
    const environment = await getRuntimeEnvironmentContext(options.cwd, now());
    const staticParts = buildStaticSystemParts();
    const sections = await collect(environment);
    return {
      environment,
      staticParts,
      systemParts: assembleSystemPrompt(staticParts, sections),
      seen: new Map(sections.map((section) => [section.name, section.text])),
      seenDate: environment.date,
    };
  }

  return {
    async prepareTurn(turn = {}) {
      const ignoreMemoryNote = turn.userQuery && shouldIgnoreMemory(turn.userQuery)
        ? "The user asked not to use memory for this turn. Do not read or rely on the memory index when answering."
        : null;

      if (!snapshot || !sameParts(snapshot.staticParts, buildStaticSystemParts())) {
        snapshot = await build();
        return { systemParts: snapshot.systemParts, update: formatUpdate(ignoreMemoryNote ? [["Memory", ignoreMemoryNote]] : []) };
      }

      const entries: Array<[string, string]> = [];
      const today = getLocalDateString(now());
      if (today !== snapshot.seenDate) {
        entries.push(["Date", `Today's date is now ${today}.`]);
        snapshot.seenDate = today;
      }
      for (const section of await collect(snapshot.environment)) {
        if (section.name === "environment") continue;
        const previous = snapshot.seen.get(section.name) ?? "";
        if (section.text === previous) continue;
        entries.push([
          SECTION_TITLES[section.name],
          section.text || "This section no longer applies. Disregard the earlier version.",
        ]);
        snapshot.seen.set(section.name, section.text);
      }
      if (ignoreMemoryNote) entries.push(["Memory", ignoreMemoryNote]);
      return { systemParts: snapshot.systemParts, update: formatUpdate(entries) };
    },

    async peekSystemParts() {
      return snapshot?.systemParts ?? (snapshot = await build()).systemParts;
    },

    reset() {
      snapshot = null;
    },
  };
}

function sameParts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function formatUpdate(entries: Array<[string, string]>): string | null {
  if (entries.length === 0) return null;
  const body = entries.map(([title, text]) => `## ${title}\n${text}`).join("\n\n");
  return (
    `${CONTEXT_UPDATE_MARKER}\n<system-reminder>\n` +
    "The session context changed after the system prompt was written. " +
    "Where a section below differs from the system prompt, follow the version below.\n\n" +
    `${body}\n</system-reminder>`
  );
}

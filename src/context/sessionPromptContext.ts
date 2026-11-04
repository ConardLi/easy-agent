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
import type { ResolvedHarness } from "../harness/resolve.js";
import { shouldIgnoreMemory } from "./memory/memdir.js";
import {
  assembleSystemPrompt,
  buildStaticSystemParts,
  collectDynamicSections,
  getLocalDateString,
  getRuntimeEnvironmentContext,
  promptHarnessFor,
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

/** A section the Agent adds is titled by its name. */
const sectionTitle = (name: string): string => SECTION_TITLES[name as PromptSectionName] ?? name;

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
  /** The same prompt with the dynamic sections it was assembled from. */
  peek(): Promise<{ systemParts: string[]; sections: PromptSection[] }>;
  /** Drop the snapshot so the next turn builds a fresh system prompt. */
  reset(): void;
}

interface Snapshot {
  environment: RuntimeEnvironmentContext;
  staticParts: string[];
  systemParts: string[];
  /** Dynamic sections in `systemParts`, as built. */
  sections: PromptSection[];
  /** Section text as the model last saw it, from the prompt or a later update. */
  seen: Map<string, string>;
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

  const collect = (
    environment: RuntimeEnvironmentContext,
    harness: ResolvedHarness | undefined,
  ): Promise<PromptSection[]> =>
    collectDynamicSections({
      cwd: options.cwd,
      environment,
      additionalInstructions: options.additionalInstructions,
      harness,
    });

  async function build(harness: ResolvedHarness | undefined): Promise<Snapshot> {
    const environment = await getRuntimeEnvironmentContext(options.cwd, now());
    const staticParts = buildStaticSystemParts(harness);
    const sections = await collect(environment, harness);
    return {
      environment,
      staticParts,
      systemParts: assembleSystemPrompt(staticParts, sections),
      sections,
      seen: new Map(sections.map((section) => [section.name, section.text])),
      seenDate: environment.date,
    };
  }

  async function peek(): Promise<{ systemParts: string[]; sections: PromptSection[] }> {
    snapshot ??= await build(await promptHarnessFor(options.cwd));
    return { systemParts: snapshot.systemParts, sections: snapshot.sections };
  }

  return {
    async prepareTurn(turn = {}) {
      const ignoreMemoryNote =
        turn.userQuery && shouldIgnoreMemory(turn.userQuery)
          ? "The user asked not to use memory for this turn. Do not read or rely on the memory index when answering."
          : null;
      // One read of the Agent per turn, so the static block and the sections agree.
      const harness = await promptHarnessFor(options.cwd);

      if (!snapshot || !sameParts(snapshot.staticParts, buildStaticSystemParts(harness))) {
        snapshot = await build(harness);
        return {
          systemParts: snapshot.systemParts,
          update: formatUpdate(ignoreMemoryNote ? [["Memory", ignoreMemoryNote]] : []),
        };
      }

      const entries: Array<[string, string]> = [];
      const today = getLocalDateString(now());
      if (today !== snapshot.seenDate) {
        entries.push(["Date", `Today's date is now ${today}.`]);
        snapshot.seenDate = today;
      }
      const current = await collect(snapshot.environment, harness);
      const currentNames = new Set(current.map((section) => section.name));
      // A section the Agent no longer adds is reported as removed.
      const gone = [...snapshot.seen.keys()]
        .filter((name) => !currentNames.has(name))
        .map((name) => ({ name, text: "" }));
      for (const section of [...current, ...gone]) {
        if (section.name === "environment") continue;
        const previous = snapshot.seen.get(section.name) ?? "";
        if (section.text === previous) continue;
        entries.push([
          sectionTitle(section.name),
          section.text || "This section no longer applies. Disregard the earlier version.",
        ]);
        snapshot.seen.set(section.name, section.text);
      }
      if (ignoreMemoryNote) entries.push(["Memory", ignoreMemoryNote]);
      return { systemParts: snapshot.systemParts, update: formatUpdate(entries) };
    },

    async peekSystemParts() {
      return (await peek()).systemParts;
    },

    peek,

    reset() {
      snapshot = null;
    },
  };
}

/** A hidden context message telling the model about a change it did not make itself. */
export function formatContextNote(notes: readonly string[]): string {
  return `${CONTEXT_UPDATE_MARKER}\n<system-reminder>\n${notes.join("\n\n")}\n</system-reminder>`;
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

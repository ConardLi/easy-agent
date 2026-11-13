import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatAgentMdSection, listAgentMdFiles } from "./claudeMd.js";
import { joinParts, type PromptPart } from "../utils/promptParts.js";
import {
  buildMemoryPromptInstructions,
  ensureMemoryDirExists,
  formatMemorySystemLocation,
  readMemoryEntrypoint,
  shouldIgnoreMemory,
} from "./memory/memdir.js";
import {
  buildMemoryAccessGuidance,
  buildMemoryExclusionGuidance,
  buildMemoryPersistenceBoundaryGuidance,
  buildMemoryTypeGuidance,
  buildMemoryValidationGuidance,
} from "./memory/memoryTypes.js";
import { formatSkillsSystemReminderParts } from "../services/skills/budget.js";
import { getModelVisibleSkills } from "../services/skills/registry.js";
import { formatAgentsSystemReminderParts } from "../agents/promptInjection.js";
import { formatTeamSystemReminder } from "../agents/teamPromptInjection.js";
import { getAllAgents } from "../agents/registry.js";
import { getActiveOutputStyleConfig } from "../styles/registry.js";
import { harnessFor } from "../harness/active.js";
import {
  arrangePromptSections,
  type ContextSourceName,
  contextSourceLoaded,
  contextSourceOn,
  identityText,
  keepsBuiltInText,
  promptSectionSettings,
} from "../harness/prompt.js";
import { harnessValue, type ResolvedHarness } from "../harness/resolve.js";
import {
  SYSTEM_PROMPT_DYNAMIC_END,
  SYSTEM_PROMPT_DYNAMIC_START,
  SYSTEM_PROMPT_STATIC_END,
  SYSTEM_PROMPT_STATIC_START,
} from "../constants/systemPromptMarkers.js";

export { SYSTEM_PROMPT_DYNAMIC_END, SYSTEM_PROMPT_DYNAMIC_START, SYSTEM_PROMPT_STATIC_END, SYSTEM_PROMPT_STATIC_START };

const execFileAsync = promisify(execFile);

export interface RuntimeEnvironmentContext {
  cwd: string;
  date: string;
  os: string;
  gitBranch?: string;
  gitStatus?: string;
  gitRecentCommit?: string;
}

export interface BuildSystemPromptOptions {
  cwd: string;
  additionalInstructions?: string;
  userQuery?: string;
}

/** Named parts of the built-in dynamic system prompt block, in prompt order. */
export type PromptSectionName =
  | "output_style"
  | "language"
  | "environment"
  | "agent_md"
  | "memory"
  | "session_instructions"
  | "skills"
  | "agents"
  | "team";

/**
 * One dynamic section: a built-in one (`PromptSectionName`) or one the Agent
 * adds under its own name. `text` is empty when the section does not apply.
 */
export interface PromptSection {
  name: string;
  text: string;
}

export interface CollectDynamicSectionsOptions {
  cwd: string;
  environment: RuntimeEnvironmentContext;
  additionalInstructions?: string;
  /** Leave the memory index out and say so (the user asked not to use memory). */
  ignoreMemory?: boolean;
  /**
   * The Agent whose prompt and context settings apply; resolved for `cwd`
   * when the key is absent. Undefined keeps the built-in sections as they are.
   */
  harness?: ResolvedHarness | undefined;
}

/**
 * The Agent the prompt of `cwd` follows, with its settings files as they are
 * now. Undefined when it cannot be resolved; the prompt then uses the
 * built-in text and loads every context source.
 */
export function promptHarnessFor(cwd: string): Promise<ResolvedHarness | undefined> {
  return harnessFor(cwd, { current: true }).catch(() => undefined);
}

// Identity framing — always present, regardless of output style, unless the
// Agent replaces it (`prompt.identity`).
const IDENTITY_SECTIONS = [
  "You are Easy Agent, a terminal-native local coding assistant running inside the user's workspace.",
  "Treat the current working directory and explicitly configured additional directories as the file-tool boundary. Easy Agent exposes its plans directory when a plan file is required; memory, sessions, and other internal state are managed through dedicated runtime features.",
];

// Coding instructions — dropped when an output style sets
// keepCodingInstructions:false (the style then fully owns the agent's
// behaviour). Built-in styles keep them; only opt-out custom styles strip.
const CODING_INSTRUCTION_SECTIONS = [
  "Operate directly, be concise, and prefer taking concrete actions with tools when useful.",
  "When solving coding tasks, first understand the relevant files, then make focused changes, then verify with the least expensive effective command.",
  "Prefer specialized tools over shell when possible: use Read for reading files, Edit for precise changes, Write for full file creation or overwrite, Grep for content search, Glob for file discovery, and Bash only when shell execution is actually needed.",
  "When editing code, preserve existing behavior unless the user explicitly asks for a behavior change.",
  "If a command or edit fails, explain the failure briefly and choose the next best action based on the observed result.",
  "Keep answers structured and practical. Summarize what you changed or found, and avoid unnecessary narration.",
];

function getStaticPromptSections(keepCodingInstructions: boolean, identity: string | undefined): string[] {
  const identitySections = identity === undefined ? IDENTITY_SECTIONS : identity ? [identity] : [];
  return keepCodingInstructions ? [...identitySections, ...CODING_INSTRUCTION_SECTIONS] : [...identitySections];
}

async function getGitContext(
  cwd: string,
): Promise<Pick<RuntimeEnvironmentContext, "gitBranch" | "gitStatus" | "gitRecentCommit">> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, maxBuffer: 32 * 1024 }),
      execFileAsync("git", ["status", "--short"], { cwd, maxBuffer: 64 * 1024 }),
      execFileAsync("git", ["log", "-1", "--pretty=format:%h %s"], { cwd, maxBuffer: 32 * 1024 }),
    ]);

    const status = statusResult.stdout.trim();
    return {
      gitBranch: branchResult.stdout.trim(),
      gitStatus: status || "clean",
      gitRecentCommit: logResult.stdout.trim() || undefined,
    };
  } catch {
    return {};
  }
}

/** Local calendar date as YYYY-MM-DD. Day precision keeps the prompt stable within a day. */
export function getLocalDateString(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export async function getRuntimeEnvironmentContext(
  cwd: string,
  now: Date = new Date(),
): Promise<RuntimeEnvironmentContext> {
  const git = await getGitContext(cwd);
  return {
    cwd,
    date: getLocalDateString(now),
    os: os.platform() + " " + os.release() + " (" + os.arch() + ")",
    ...git,
  };
}

function formatEnvironmentContext(context: RuntimeEnvironmentContext, harness: ResolvedHarness | undefined): string {
  const withEnvironment = !harness || contextSourceOn(harness, "environment");
  const withGit = !harness || contextSourceOn(harness, "git_status");
  if (!withEnvironment && !withGit) return "";
  const lines = ["Environment:"];
  if (withEnvironment) {
    lines.push(
      "- Current working directory: " + context.cwd,
      "- Today's date: " + context.date,
      "- Operating system: " + context.os,
    );
  }
  if (!withGit) return lines.join("\n");

  if (context.gitBranch) {
    lines.push("- Git branch at session start: " + context.gitBranch);
  }
  if (context.gitStatus) {
    lines.push(
      "- Git status at session start (a snapshot that is not updated during the session; run git to see the current state):\n" +
        context.gitStatus,
    );
  }
  if (context.gitRecentCommit) {
    lines.push("- Most recent commit at session start: " + context.gitRecentCommit);
  }

  return lines.join("\n");
}

/**
 * Static block: identity plus coding instructions. Changes only when the
 * Agent's identity text changes or the active output style toggles
 * `keepCodingInstructions`.
 */
export function buildStaticSystemParts(harness?: ResolvedHarness): string[] {
  // Output style reshapes HOW the agent answers. A non-null
  // config means a non-default style is active; keepCodingInstructions
  // decides whether the base coding guidance survives.
  const activeStyle = getActiveOutputStyleConfig();
  const keepCodingInstructions = !activeStyle || activeStyle.keepCodingInstructions !== false;
  return [
    SYSTEM_PROMPT_STATIC_START,
    ...getStaticPromptSections(keepCodingInstructions, harness ? identityText(harness) : undefined),
    SYSTEM_PROMPT_STATIC_END,
  ];
}

/** Join the static block and the non-empty dynamic sections into prompt parts. */
export function assembleSystemPrompt(staticParts: string[], sections: readonly PromptSection[]): string[] {
  return [
    ...staticParts,
    SYSTEM_PROMPT_DYNAMIC_START,
    ...sections.map((section) => section.text).filter(Boolean),
    SYSTEM_PROMPT_DYNAMIC_END,
  ];
}

/**
 * The prompt `renderSystemPrompt(assembleSystemPrompt(staticParts, sections))`
 * in parts with their components, in order: the block markers, the identity
 * and coding instructions of the static block, and the non-empty dynamic
 * sections, split further into rule files, the memory index, and the skills
 * and sub-agents they list. Joined, the parts are the prompt; the blank line
 * between two parts counts toward the first.
 */
export function systemPromptLayout(staticParts: readonly string[], sections: readonly PromptSection[]): PromptPart[] {
  const markers = new Set([
    SYSTEM_PROMPT_STATIC_START,
    SYSTEM_PROMPT_STATIC_END,
    SYSTEM_PROMPT_DYNAMIC_START,
    SYSTEM_PROMPT_DYNAMIC_END,
  ]);
  const instructions = new Set(CODING_INSTRUCTION_SECTIONS);
  const staticComponent = (text: string) =>
    markers.has(text)
      ? "prompt:marker"
      : instructions.has(text)
        ? "prompt_section:instructions"
        : "prompt_section:identity";
  const blocks: PromptPart[][] = [
    ...staticParts.map((text) => [{ component: staticComponent(text), text }]),
    [{ component: "prompt:marker", text: SYSTEM_PROMPT_DYNAMIC_START }],
    ...sections
      .filter((section) => section.text)
      .map((section) => partsOfSection(section).map((part) => ({ ...part }))),
    [{ component: "prompt:marker", text: SYSTEM_PROMPT_DYNAMIC_END }],
  ];
  blocks.forEach((block, index) => {
    if (index < blocks.length - 1) block.at(-1)!.text += "\n\n";
  });
  return blocks.flat();
}

/**
 * Build a complete system prompt from the current workspace state. The main
 * session uses `createSessionPromptContext` instead, which keeps this prompt
 * fixed for the session and reports later changes separately.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string[]> {
  const ignoreMemory = options.userQuery ? shouldIgnoreMemory(options.userQuery) : false;
  const [environment, harness] = await Promise.all([
    getRuntimeEnvironmentContext(options.cwd),
    promptHarnessFor(options.cwd),
  ]);
  const sections = await collectDynamicSections({
    cwd: options.cwd,
    environment,
    additionalInstructions: options.additionalInstructions,
    ignoreMemory,
    harness,
  });
  return assembleSystemPrompt(buildStaticSystemParts(harness), sections);
}

/**
 * Every dynamic section in prompt order, including empty ones, so callers can
 * compare two collections section by section. The Agent's `prompt.sections`
 * decides which sections are left out, replaced, added, and where they go;
 * its `context` settings decide which sources the built-in sections load.
 */
export async function collectDynamicSections(options: CollectDynamicSectionsOptions): Promise<PromptSection[]> {
  const ignoreMemory = options.ignoreMemory === true;
  const harness = "harness" in options ? options.harness : await promptHarnessFor(options.cwd);
  // A section the Agent turns off or replaces never shows its built-in text, so its sources are not read.
  const loads = (source: ContextSourceName) => contextSourceLoaded(harness, source);

  const withMemory = keepsBuiltInText(harness, "memory");
  const memoryDir = withMemory ? await ensureMemoryDirExists(options.cwd) : "";
  const [agentMdFiles, memoryEntrypoint] = await Promise.all([
    loads("agent_md") ? listAgentMdFiles(options.cwd) : Promise.resolve([]),
    ignoreMemory || !loads("memory") ? Promise.resolve(null) : readMemoryEntrypoint(options.cwd),
  ]);
  const loadedAgentMd = agentMdFiles.filter((file) => !file.excluded);
  const language = harness ? harnessValue<string | undefined>(harness, "prompt.language") : undefined;
  const activeStyle = getActiveOutputStyleConfig();

  const memorySections = withMemory
    ? [
        ...formatMemorySystemLocation(memoryDir),
        ...buildMemoryPromptInstructions(),
        ...buildMemoryTypeGuidance(),
        ...buildMemoryExclusionGuidance(),
        ...buildMemoryAccessGuidance(),
        ...buildMemoryValidationGuidance(),
        ...buildMemoryPersistenceBoundaryGuidance(),
        ignoreMemory ? "Memory is disabled for this turn because the user asked not to use it." : "",
      ].filter(Boolean)
    : [];
  const memoryParts: PromptPart[] = memorySections.length
    ? [{ component: "prompt_section:memory", text: memorySections.join("\n\n") }]
    : [];
  if (withMemory && memoryEntrypoint) {
    memoryParts.push(
      { component: "prompt_section:memory", text: `${memoryParts.length ? "\n\n" : ""}Memory index:\n` },
      { component: "rule:memory", text: memoryEntrypoint },
    );
  }
  const agentMdParts: PromptPart[] = loadedAgentMd.length
    ? [
        { component: "prompt_section:agent_md", text: "Project memory (AGENT.md):\n" },
        ...loadedAgentMd.map((file, index) => ({
          component: `rule:${file.filePath}`,
          text: formatAgentMdSection(file) + (index < loadedAgentMd.length - 1 ? "\n\n" : ""),
        })),
      ]
    : [];

  // Skill discovery listing — see skills/budget.ts for the budget logic.
  // Wrapped as a <system-reminder> block (not a top-level instruction) so the
  // model treats it as ambient context that may or may not apply this turn.
  // Conditional skills (frontmatter `paths`) only appear here AFTER they've
  // been promoted in by activateConditionalSkillsForPaths(); see
  // skills/conditional.ts.
  const skillsParts = loads("skills") ? formatSkillsSystemReminderParts(getModelVisibleSkills(harness)) : [];

  // Agents discovery listing — same pattern as skills. Tells the model
  // which `subagent_type` values it can pass to the Agent tool. The
  // registry is populated at startup by bootstrapAgents() in cli.ts.
  const agentsParts = loads("agents") ? formatAgentsSystemReminderParts(getAllAgents(harness)) : [];

  // Agent Teams reminder — appears only when the feature flag
  // is on AND a team is currently active. The model already sees the
  // TeamCreate/TeamDelete/SendMessage tool schemas when the flag is on;
  // this block adds the workflow guidance source bakes into
  // `teammatePromptAddendum.ts`. We intentionally show it ONLY while a
  // team is active so the model doesn't drown in team-coordination
  // instructions during a single-agent conversation.
  const teamReminder = formatTeamSystemReminder();

  // The active output-style prompt, injected as a labelled
  // section. Placed in the dynamic block (not static) because the user can
  // flip styles at runtime via /output-style; the session prompt context
  // announces such a change at the end of the conversation.
  const outputStyleSection = activeStyle ? `# Output Style: ${activeStyle.name}\n${activeStyle.prompt}` : "";

  // Preferred response language (settings `language`). Dynamic so a runtime
  // change takes effect next turn. Phrased as an instruction, not a hard
  // constraint on tool I/O — code/identifiers stay as-is.
  const languageSection = language
    ? `Respond to the user in ${language}, unless they explicitly ask for another language. Keep code, file paths, and identifiers unchanged.`
    : "";

  const builtIn: PromptSection[] = [
    { name: "output_style", text: outputStyleSection },
    { name: "language", text: languageSection },
    { name: "environment", text: formatEnvironmentContext(options.environment, harness) },
    { name: "agent_md", text: withParts(agentMdParts) },
    { name: "memory", text: withParts(memoryParts) },
    {
      name: "session_instructions",
      text: options.additionalInstructions ? "Session instructions:\n" + options.additionalInstructions : "",
    },
    { name: "skills", text: withParts(skillsParts) },
    { name: "agents", text: withParts(agentsParts) },
    { name: "team", text: teamReminder },
  ];
  return harness ? arrangePromptSections(builtIn, promptSectionSettings(harness)) : builtIn;
}

// ─── Section parts ──────────────────────────────────────────────────────

const MAX_SECTION_PARTS = 64;
const sectionParts = new Map<string, readonly PromptPart[]>();

/** Join `parts` into a section's text and remember them for `systemPromptLayout`. */
function withParts(parts: readonly PromptPart[]): string {
  const text = joinParts(parts);
  if (parts.length > 1) {
    sectionParts.delete(text);
    sectionParts.set(text, parts);
    if (sectionParts.size > MAX_SECTION_PARTS) sectionParts.delete(sectionParts.keys().next().value!);
  }
  return text;
}

/**
 * The parts of a section: the rule files of the project memory section, the
 * memory index, one per listed skill or sub-agent. A section whose text is
 * not the joined parts (the Agent replaced it) is one part.
 */
function partsOfSection(section: PromptSection): readonly PromptPart[] {
  const parts = sectionParts.get(section.text);
  return parts && joinParts(parts) === section.text
    ? parts
    : [{ component: `prompt_section:${section.name}`, text: section.text }];
}

export function renderSystemPrompt(parts: string[]): string {
  return parts.join("\n\n");
}

import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadAgentMdContext } from "./claudeMd.js";
import { buildMemoryPromptInstructions, ensureMemoryDirExists, formatMemorySystemLocation, readMemoryEntrypoint, shouldIgnoreMemory } from "./memory/memdir.js";
import { buildMemoryAccessGuidance, buildMemoryExclusionGuidance, buildMemoryPersistenceBoundaryGuidance, buildMemoryTypeGuidance, buildMemoryValidationGuidance } from "./memory/memoryTypes.js";
import { formatSkillsSystemReminder } from "../services/skills/budget.js";
import { getModelVisibleSkills } from "../services/skills/registry.js";
import { formatAgentsSystemReminder } from "../agents/promptInjection.js";
import { formatTeamSystemReminder } from "../agents/teamPromptInjection.js";
import { getAllAgents } from "../agents/registry.js";
import { getActiveOutputStyleConfig } from "../styles/registry.js";
import { readMergedStringSetting } from "../utils/settings.js";
import {
  SYSTEM_PROMPT_DYNAMIC_END,
  SYSTEM_PROMPT_DYNAMIC_START,
  SYSTEM_PROMPT_STATIC_END,
  SYSTEM_PROMPT_STATIC_START,
} from "../constants/systemPromptMarkers.js";

export {
  SYSTEM_PROMPT_DYNAMIC_END,
  SYSTEM_PROMPT_DYNAMIC_START,
  SYSTEM_PROMPT_STATIC_END,
  SYSTEM_PROMPT_STATIC_START,
};

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

/** Named parts of the dynamic system prompt block, in prompt order. */
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

/** One dynamic section. `text` is empty when the section does not apply. */
export interface PromptSection {
  name: PromptSectionName;
  text: string;
}

export interface CollectDynamicSectionsOptions {
  cwd: string;
  environment: RuntimeEnvironmentContext;
  additionalInstructions?: string;
  /** Leave the memory index out and say so (the user asked not to use memory). */
  ignoreMemory?: boolean;
}

// Identity framing — always present, regardless of output style.
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

function getStaticPromptSections(keepCodingInstructions: boolean): string[] {
  return keepCodingInstructions
    ? [...IDENTITY_SECTIONS, ...CODING_INSTRUCTION_SECTIONS]
    : [...IDENTITY_SECTIONS];
}

async function getGitContext(cwd: string): Promise<Pick<RuntimeEnvironmentContext, "gitBranch" | "gitStatus" | "gitRecentCommit">> {
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
    os:       os.platform() + " " + os.release() + " (" + os.arch() + ")",
    ...git,
  };
}

function formatEnvironmentContext(context: RuntimeEnvironmentContext): string {
  const lines = [
    "Environment:",
    "- Current working directory: " + context.cwd,
    "- Today's date: " + context.date,
    "- Operating system: " + context.os,
  ];

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
 * active output style toggles `keepCodingInstructions`.
 */
export function buildStaticSystemParts(): string[] {
  // Output style reshapes HOW the agent answers. A non-null
  // config means a non-default style is active; keepCodingInstructions
  // decides whether the base coding guidance survives.
  const activeStyle = getActiveOutputStyleConfig();
  const keepCodingInstructions = !activeStyle || activeStyle.keepCodingInstructions !== false;
  return [
    SYSTEM_PROMPT_STATIC_START,
    ...getStaticPromptSections(keepCodingInstructions),
    SYSTEM_PROMPT_STATIC_END,
  ];
}

/** Join the static block and the non-empty dynamic sections into prompt parts. */
export function assembleSystemPrompt(staticParts: string[], sections: PromptSection[]): string[] {
  return [
    ...staticParts,
    SYSTEM_PROMPT_DYNAMIC_START,
    ...sections.map((section) => section.text).filter(Boolean),
    SYSTEM_PROMPT_DYNAMIC_END,
  ];
}

/**
 * Build a complete system prompt from the current workspace state. The main
 * session uses `createSessionPromptContext` instead, which keeps this prompt
 * fixed for the session and reports later changes separately.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string[]> {
  const ignoreMemory = options.userQuery ? shouldIgnoreMemory(options.userQuery) : false;
  const environment = await getRuntimeEnvironmentContext(options.cwd);
  const sections = await collectDynamicSections({
    cwd: options.cwd,
    environment,
    additionalInstructions: options.additionalInstructions,
    ignoreMemory,
  });
  return assembleSystemPrompt(buildStaticSystemParts(), sections);
}

/**
 * Every dynamic section in prompt order, including empty ones, so callers can
 * compare two collections section by section.
 */
export async function collectDynamicSections(options: CollectDynamicSectionsOptions): Promise<PromptSection[]> {
  const ignoreMemory = options.ignoreMemory === true;
  const memoryDir = await ensureMemoryDirExists(options.cwd);
  const [agentMdContext, memoryEntrypoint, language] = await Promise.all([
    loadAgentMdContext(options.cwd),
    ignoreMemory ? Promise.resolve(null) : readMemoryEntrypoint(options.cwd),
    readMergedStringSetting(options.cwd, "language").catch(() => undefined),
  ]);
  const activeStyle = getActiveOutputStyleConfig();

  const memorySections = [
    ...formatMemorySystemLocation(memoryDir),
    ...buildMemoryPromptInstructions(),
    ...buildMemoryTypeGuidance(),
    ...buildMemoryExclusionGuidance(),
    ...buildMemoryAccessGuidance(),
    ...buildMemoryValidationGuidance(),
    ...buildMemoryPersistenceBoundaryGuidance(),
    ignoreMemory ? "Memory is disabled for this turn because the user asked not to use it." : "",
    memoryEntrypoint ? `Memory index:\n${memoryEntrypoint}` : "",
  ].filter(Boolean);

  // Skill discovery listing — see skills/budget.ts for the budget logic.
  // Wrapped as a <system-reminder> block (not a top-level instruction) so the
  // model treats it as ambient context that may or may not apply this turn.
  // Conditional skills (frontmatter `paths`) only appear here AFTER they've
  // been promoted in by activateConditionalSkillsForPaths(); see
  // skills/conditional.ts.
  const skillsReminder = formatSkillsSystemReminder(getModelVisibleSkills());

  // Agents discovery listing — same pattern as skills. Tells the model
  // which `subagent_type` values it can pass to the Agent tool. The
  // registry is populated at startup by bootstrapAgents() in cli.ts.
  const agentsReminder = formatAgentsSystemReminder(getAllAgents());

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
  const outputStyleSection = activeStyle
    ? `# Output Style: ${activeStyle.name}\n${activeStyle.prompt}`
    : "";

  // Preferred response language (settings `language`). Dynamic so a runtime
  // change takes effect next turn. Phrased as an instruction, not a hard
  // constraint on tool I/O — code/identifiers stay as-is.
  const languageSection = language
    ? `Respond to the user in ${language}, unless they explicitly ask for another language. Keep code, file paths, and identifiers unchanged.`
    : "";

  return [
    { name: "output_style", text: outputStyleSection },
    { name: "language", text: languageSection },
    { name: "environment", text: formatEnvironmentContext(options.environment) },
    { name: "agent_md", text: agentMdContext ? "Project memory (AGENT.md):\n" + agentMdContext : "" },
    { name: "memory", text: memorySections.length > 0 ? memorySections.join("\n\n") : "" },
    {
      name: "session_instructions",
      text: options.additionalInstructions ? "Session instructions:\n" + options.additionalInstructions : "",
    },
    { name: "skills", text: skillsReminder },
    { name: "agents", text: agentsReminder },
    { name: "team", text: teamReminder },
  ];
}

export function renderSystemPrompt(parts: string[]): string {
  return parts.join("\n\n");
}

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

const execFileAsync = promisify(execFile);

export const SYSTEM_PROMPT_STATIC_START = "<SYSTEM_STATIC_CONTEXT>";
export const SYSTEM_PROMPT_STATIC_END = "</SYSTEM_STATIC_CONTEXT>";
export const SYSTEM_PROMPT_DYNAMIC_START = "<SYSTEM_DYNAMIC_CONTEXT>";
export const SYSTEM_PROMPT_DYNAMIC_END = "</SYSTEM_DYNAMIC_CONTEXT>";

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

// Identity framing — always present, regardless of output style.
const IDENTITY_SECTIONS = [
  "You are Easy Agent, a terminal-native local coding assistant running inside the user's workspace.",
  "Treat the current working directory as the primary workspace boundary. The Easy Agent system directory at ~/.easy-agent is also available for memory and session storage; do not assume other outside paths are available.",
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

export async function getRuntimeEnvironmentContext(cwd: string): Promise<RuntimeEnvironmentContext> {
  const git = await getGitContext(cwd);
  return {
    cwd,
    date: new Date().toISOString(),
    os:       os.platform() + " " + os.release() + " (" + os.arch() + ")",
    ...git,
  };
}

function formatEnvironmentContext(context: RuntimeEnvironmentContext): string {
  const lines = [
    "Environment:",
    "- Current working directory: " + context.cwd,
    "- Current date: " + context.date,
    "- Operating system: " + context.os,
  ];

  if (context.gitBranch) {
    lines.push("- Git branch: " + context.gitBranch);
  }
  if (context.gitStatus) {
    lines.push("- Git status snapshot:\n" + context.gitStatus);
  }
  if (context.gitRecentCommit) {
    lines.push("- Recent commit: " + context.gitRecentCommit);
  }

  return lines.join("\n");
}

export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string[]> {
  const ignoreMemory = options.userQuery ? shouldIgnoreMemory(options.userQuery) : false;
  const memoryDir = await ensureMemoryDirExists(options.cwd);
  const [environmentContext, agentMdContext, memoryEntrypoint, language] = await Promise.all([
    getRuntimeEnvironmentContext(options.cwd),
    loadAgentMdContext(options.cwd),
    ignoreMemory ? Promise.resolve(null) : readMemoryEntrypoint(options.cwd),
    readMergedStringSetting(options.cwd, "language").catch(() => undefined),
  ]);

  // Stage 23: output style reshapes HOW the agent answers. A non-null
  // config means a non-default style is active; keepCodingInstructions
  // decides whether the base coding guidance survives.
  const activeStyle = getActiveOutputStyleConfig();
  const keepCodingInstructions = !activeStyle || activeStyle.keepCodingInstructions !== false;

  const staticSections = [
    SYSTEM_PROMPT_STATIC_START,
    ...getStaticPromptSections(keepCodingInstructions),
    SYSTEM_PROMPT_STATIC_END,
  ];

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

  // Stage 21: Agent Teams reminder — appears only when the feature flag
  // is on AND a team is currently active. The model already sees the
  // TeamCreate/TeamDelete/SendMessage tool schemas when the flag is on;
  // this block adds the workflow guidance source bakes into
  // `teammatePromptAddendum.ts`. We intentionally show it ONLY while a
  // team is active so the model doesn't drown in team-coordination
  // instructions during a single-agent conversation.
  const teamReminder = formatTeamSystemReminder();

  // Stage 23: the active output-style prompt, injected as a labelled
  // section. Placed in the dynamic block (not static) because the user can
  // flip styles at runtime via /output-style and we want the change to take
  // effect on the very next turn without a cache-stale prefix.
  const outputStyleSection = activeStyle
    ? `# Output Style: ${activeStyle.name}\n${activeStyle.prompt}`
    : "";

  // Preferred response language (settings `language`). Dynamic so a runtime
  // change takes effect next turn. Phrased as an instruction, not a hard
  // constraint on tool I/O — code/identifiers stay as-is.
  const languageSection = language
    ? `Respond to the user in ${language}, unless they explicitly ask for another language. Keep code, file paths, and identifiers unchanged.`
    : "";

  const dynamicSections = [
    SYSTEM_PROMPT_DYNAMIC_START,
    outputStyleSection,
    languageSection,
    formatEnvironmentContext(environmentContext),
    agentMdContext ? "Project memory (AGENT.md):\n" + agentMdContext : "",
    memorySections.length > 0 ? memorySections.join("\n\n") : "",
    options.additionalInstructions ? "Session instructions:\n" + options.additionalInstructions : "",
    skillsReminder,
    agentsReminder,
    teamReminder,
    SYSTEM_PROMPT_DYNAMIC_END,
  ].filter(Boolean);

  return [...staticSections, ...dynamicSections];
}

export function renderSystemPrompt(parts: string[]): string {
  return parts.join("\n\n");
}

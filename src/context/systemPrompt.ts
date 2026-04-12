import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadAgentMdContext } from "./claudeMd.js";
import { findRelevantMemories } from "./memory/findRelevantMemories.js";
import { buildMemoryPromptInstructions, ensureMemoryDirExists, readMemoryEntrypoint, shouldIgnoreMemory } from "./memory/memdir.js";
import { buildMemoryValidationGuidance } from "./memory/memoryTypes.js";

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

function getStaticPromptSections(): string[] {
  return [
    "You are Easy Agent, a terminal-native local coding assistant running inside the user's workspace.",
    "Operate directly, be concise, and prefer taking concrete actions with tools when useful.",
    "When solving coding tasks, first understand the relevant files, then make focused changes, then verify with the least expensive effective command.",
    "Prefer specialized tools over shell when possible: use Read for reading files, Edit for precise changes, Write for full file creation or overwrite, Grep for content search, Glob for file discovery, and Bash only when shell execution is actually needed.",
    "Respect the current working directory as your workspace boundary. Do not assume files outside the workspace are available.",
    "When editing code, preserve existing behavior unless the user explicitly asks for a behavior change.",
    "If a command or edit fails, explain the failure briefly and choose the next best action based on the observed result.",
    "Keep answers structured and practical. Summarize what you changed or found, and avoid unnecessary narration.",
  ];
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
  const [environmentContext, agentMdContext, memoryEntrypoint, relevantMemories] = await Promise.all([
    getRuntimeEnvironmentContext(options.cwd),
    loadAgentMdContext(options.cwd),
    ignoreMemory ? Promise.resolve(null) : readMemoryEntrypoint(options.cwd),
    options.userQuery ? findRelevantMemories(options.cwd, options.userQuery, { ignoreMemory }) : Promise.resolve([]),
  ]);

  const staticSections = [
    SYSTEM_PROMPT_STATIC_START,
    ...getStaticPromptSections(),
    SYSTEM_PROMPT_STATIC_END,
  ];

  const memorySections = [
    ...buildMemoryPromptInstructions(memoryDir),
    ...buildMemoryValidationGuidance(),
    ignoreMemory ? "Memory is disabled for this turn because the user asked not to use it." : "",
    memoryEntrypoint ? `Memory index (${memoryDir}/MEMORY.md):\n${memoryEntrypoint}` : "",
    relevantMemories.length > 0 ? `Relevant memories:\n${relevantMemories.join("\n\n---\n\n")}` : "",
  ].filter(Boolean);

  const dynamicSections = [
    SYSTEM_PROMPT_DYNAMIC_START,
    formatEnvironmentContext(environmentContext),
    agentMdContext ? "Project memory (AGENT.md):\n" + agentMdContext : "",
    memorySections.length > 0 ? memorySections.join("\n\n") : "",
    options.additionalInstructions ? "Session instructions:\n" + options.additionalInstructions : "",
    SYSTEM_PROMPT_DYNAMIC_END,
  ].filter(Boolean);

  return [...staticSections, ...dynamicSections];
}

export function renderSystemPrompt(parts: string[]): string {
  return parts.join("\n\n");
}

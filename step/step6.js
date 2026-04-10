/**
 * Step 6 - Dynamic system prompt assembly
 *
 * Goal:
 * - split prompt content into stable and runtime sections
 * - inject environment context on every turn
 * - optionally include project memory from AGENT.md
 */

import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readAgentMd(cwd) {
  const filePath = path.join(cwd, "AGENT.md");
  try {
    const content = await fs.readFile(filePath, "utf8");
    return "# Source: " + filePath + "\n" + content.trim();
  } catch {
    return "";
  }
}

async function getGitSection(cwd) {
  try {
    const [branch, status] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
      execFileAsync("git", ["status", "--short"], { cwd }),
    ]);

    return [
      "- Git branch: " + branch.stdout.trim(),
      "- Git status:\n" + (status.stdout.trim() || "clean"),
    ].join("\n");
  } catch {
    return "- Git: not available";
  }
}

export async function buildSystemPrompt({ cwd, additionalInstructions = "" }) {
  const staticSection = [
    "<SYSTEM_STATIC_CONTEXT>",
    "You are Easy Agent, a terminal-native coding assistant.",
    "Be concise, practical, and action-oriented.",
    "Prefer specialized tools before using Bash.",
    "Understand the code before changing it.",
    "</SYSTEM_STATIC_CONTEXT>",
  ].join("\n");

  const dynamicSection = [
    "<SYSTEM_DYNAMIC_CONTEXT>",
    "- Current working directory: " + cwd,
    "- Current date: " + new Date().toISOString(),
    "- OS: " + os.platform() + " " + os.release() + " (" + os.arch() + ")",
    await getGitSection(cwd),
    additionalInstructions ? "- Session instructions:\n" + additionalInstructions : "",
    await readAgentMd(cwd),
    "</SYSTEM_DYNAMIC_CONTEXT>",
  ]
    .filter(Boolean)
    .join("\n\n");

  return staticSection + "\n\n" + dynamicSection;
}

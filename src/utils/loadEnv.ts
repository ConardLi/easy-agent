/**
 * loadEnv — Multi-source environment variable loader.
 *
 * Loads env vars from multiple sources with increasing priority
 * (later sources override earlier ones):
 *
 *   1. ~/.claude.json        → global config `env` field
 *   2. ~/.claude/settings.json → user settings `env` field
 *   3. .env (cwd)            → project-local dotenv file
 *
 * This mirrors how claude-code-source-code handles env loading
 * via Object.assign (higher priority overwrites lower), while
 * keeping the simplicity of dotenv for project-local overrides.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";

interface ClaudeConfig {
  env?: Record<string, string>;
}

function readJsonEnv(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: ClaudeConfig = JSON.parse(raw);
    if (parsed.env && typeof parsed.env === "object") {
      return parsed.env;
    }
  } catch {
    // File doesn't exist or is invalid JSON — silently skip
  }
  return {};
}

export function loadEnv(): void {
  const home = process.env.HOME || "~";

  // 1. ~/.claude.json (lowest priority)
  const globalConfigEnv = readJsonEnv(path.join(home, ".claude.json"));
  Object.assign(process.env, globalConfigEnv);

  // 2. ~/.claude/settings.json
  const settingsEnv = readJsonEnv(path.join(home, ".claude", "settings.json"));
  Object.assign(process.env, settingsEnv);

  // 3. .env file (highest priority — project-local overrides everything)
  dotenv.config({ override: true });
}

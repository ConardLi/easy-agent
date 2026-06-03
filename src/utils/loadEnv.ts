/**
 * loadEnv — Multi-source environment variable loader.
 *
 * Loads env vars from the Easy Agent settings chain plus a project-local
 * dotenv file, with increasing priority (later sources override earlier ones):
 *
 *   1. ~/.easy-agent/settings.json            → user-scope `env` block
 *   2. <cwd>/.easy-agent/settings.json        → project-scope `env` block
 *   3. <cwd>/.easy-agent/settings.local.json  → project-local `env` block
 *   4. .env (cwd)                             → dotenv file (highest priority)
 *
 * The settings `env` blocks let users keep model API keys (and any other
 * variable referenced via `${VAR}` in a model profile) alongside the rest of
 * their configuration. A repo-local `.env` still wins so a developer can
 * override committed defaults without editing settings.json.
 *
 * Note: the project/local `env` blocks come from repo files. This is the same
 * trust posture as the cwd `.env` file (which dotenv already auto-loads), so it
 * introduces no attack surface beyond what `.env` provides.
 */

import * as fs from "node:fs";
import dotenv from "dotenv";
import {
  getUserSettingsPath,
  getProjectSettingsPath,
  getLocalSettingsPath,
} from "./paths.js";

function readJsonEnv(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "env" in parsed &&
      (parsed as { env?: unknown }).env &&
      typeof (parsed as { env?: unknown }).env === "object"
    ) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries((parsed as { env: Record<string, unknown> }).env)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // File doesn't exist or is invalid JSON — silently skip.
  }
  return {};
}

export function loadEnv(): void {
  const cwd = process.cwd();

  // Settings `env` blocks, low → high priority (later wins).
  Object.assign(process.env, readJsonEnv(getUserSettingsPath()));
  Object.assign(process.env, readJsonEnv(getProjectSettingsPath(cwd)));
  Object.assign(process.env, readJsonEnv(getLocalSettingsPath(cwd)));

  // .env file (highest priority — project-local overrides everything).
  // `quiet` suppresses dotenv's "injected env (N) from .env" tip banner so
  // the REPL opens on a clean welcome card instead of a stray log line.
  dotenv.config({ override: true, quiet: true });
}

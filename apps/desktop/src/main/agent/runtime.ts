import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LaunchCommand } from "./host";

/**
 * The `eagent` entry script the desktop app runs with Electron's Node. In
 * development it is the repository's own build (`npm run build` at the
 * repository root), linked as the `eagent` dependency.
 */
export function bundledAgentScript(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("eagent/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> };
  const entry = typeof bin === "string" ? bin : bin.eagent;
  if (!entry) throw new Error("eagent/package.json has no eagent bin entry");
  return join(dirname(manifest), entry);
}

export interface RuntimePrefs {
  agentRuntime: "bundled" | "system";
  agentPath: string;
  extraSettingsFile: string;
  debugLogging: boolean;
}

/**
 * The command line for one `eagent --rpc` process: the bundled build run with
 * Electron's Node, or an `eagent` the user installed. `secrets` become
 * environment variables, which `${VAR}` references in settings files resolve.
 */
export function launchCommand(prefs: RuntimePrefs, secrets: Record<string, string>): LaunchCommand {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, secrets);
  if (prefs.debugLogging) env.EASY_AGENT_DEBUG = "1";
  const args = ["--rpc", ...(prefs.extraSettingsFile.trim() ? ["--settings", expandHome(prefs.extraSettingsFile.trim())] : [])];
  if (prefs.agentRuntime === "system") return { command: expandHome(prefs.agentPath.trim() || "eagent"), args, env };
  return { command: process.execPath, args: [bundledAgentScript(), ...args], env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
}

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

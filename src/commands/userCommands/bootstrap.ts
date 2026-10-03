/**
 * User-command startup orchestration.
 *
 * Called once from the CLI entrypoint before the React UI mounts. Loads
 * commands from disk, populates the registry, and surfaces warnings for
 * malformed files. Mirrors services/skills/bootstrap.ts.
 */

import { loadAllUserCommands } from "./loadCommandsDir.js";
import { setUserCommands } from "./registry.js";

export interface UserCommandsBootstrapResult {
  commandCount: number;
  warnings: string[];
}

export async function bootstrapUserCommands(cwd: string): Promise<UserCommandsBootstrapResult> {
  const { commands, warnings } = await loadAllUserCommands(cwd);
  setUserCommands(commands);

  for (const warning of warnings) {
    console.warn(`[easy-agent] ${warning}`);
  }

  return {
    commandCount: commands.length,
    warnings,
  };
}

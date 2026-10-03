/**
 * User-command registry — in-memory state for loaded slash commands.
 *
 * Mirrors the skills registry shape so the UI / engine consume both with
 * the same idioms. Commands are keyed by name; project scope overrides user
 * scope at load time (handled in loadAllUserCommands).
 */

import type { UserCommand } from "./types.js";

const commands = new Map<string, UserCommand>();
let initialized = false;

/** Replace the registry with a freshly-loaded set. Called by bootstrap. */
export function setUserCommands(list: UserCommand[]): void {
  commands.clear();
  for (const cmd of list) {
    commands.set(cmd.name, cmd);
  }
  initialized = true;
}

export function isUserCommandsInitialized(): boolean {
  return initialized;
}

/** Look up a command by name (case-sensitive). */
export function findUserCommand(name: string): UserCommand | undefined {
  return commands.get(name);
}

/** All loaded commands, for the suggestion list + `/help`. */
export function getAllUserCommands(): UserCommand[] {
  return [...commands.values()];
}

/** Drop everything — tests / hot reload only. */
export function clearUserCommands(): void {
  commands.clear();
  initialized = false;
}

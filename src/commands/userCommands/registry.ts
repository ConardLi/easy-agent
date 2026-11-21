/**
 * User-command registry — in-memory state for loaded slash commands.
 *
 * Mirrors the skills registry shape so the UI / engine consume both with
 * the same idioms. Commands are keyed by name; project scope overrides user
 * scope at load time (handled in loadAllUserCommands).
 */

import type { UserCommand } from "./types.js";
import { pluginOffByAgent } from "../../harness/resources.js";
import { defineRuntimeState } from "../../state/runtimeScope.js";

const state = defineRuntimeState("userCommands", () => ({
  commands: new Map<string, UserCommand>(),
  initialized: false,
}));

/** Replace the registry with a freshly-loaded set. Called by bootstrap. */
export function setUserCommands(list: UserCommand[]): void {
  const { commands } = state();
  commands.clear();
  for (const cmd of list) {
    commands.set(cmd.name, cmd);
  }
  state().initialized = true;
}

export function isUserCommandsInitialized(): boolean {
  return state().initialized;
}

/** Look up a command by name (case-sensitive). */
export function findUserCommand(name: string): UserCommand | undefined {
  const command = state().commands.get(name);
  return command && !pluginOffByAgent(command.pluginId) ? command : undefined;
}

/** All loaded commands, for the suggestion list + `/help`. */
export function getAllUserCommands(): UserCommand[] {
  return getRegisteredUserCommands().filter((command) => !pluginOffByAgent(command.pluginId));
}

/** Every loaded command, including plugin commands the current Agent leaves out. */
export function getRegisteredUserCommands(): UserCommand[] {
  return [...state().commands.values()];
}

/** Drop everything — tests / hot reload only. */
export function clearUserCommands(): void {
  state().commands.clear();
  state().initialized = false;
}

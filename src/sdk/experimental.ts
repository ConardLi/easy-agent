/**
 * Experimental SDK exports (`eagent/sdk/experimental`). Their shapes may
 * change in a minor release; they move to `eagent/sdk` once stable.
 *
 * Agent management: the Agents in `harnesses` of the user settings file and
 * the workspace's default Agent. These work with or without a runtime. A
 * change to an Agent that the runtime in this process uses (its Agent or one
 * it extends) reloads that runtime's settings right away; other runtimes
 * resolve the change before their next model request. The results name every
 * Agent a change affects, so a frontend that runs one process per Agent can
 * reload just those.
 */

import {
  deleteHarness as deleteDefinition,
  exportHarness as exportDefinition,
  type HarnessChange,
  type HarnessDefinition,
  type HarnessExport,
  type HarnessImportOptions,
  type HarnessImportPreview,
  type HarnessListing,
  HarnessManagementError,
  type HarnessPromptFile,
  type HarnessRenameResult,
  type HarnessSummary,
  type HarnessWriteResult,
  importHarness as importDefinition,
  listHarnesses as listDefinitions,
  previewHarnessImport as previewDefinition,
  readHarness as readDefinition,
  renameHarness as renameDefinition,
  setProjectHarness as setProjectDefinition,
  writeHarness as writeDefinition,
  writeHarnessPrompt as writePromptFile,
} from "../harness/manage.js";
import { PersistentDataError } from "../utils/atomicFile.js";
import { AgentSdkError } from "./errors.js";
import { reloadRuntimeUsing } from "./runtime.js";

export type {
  HarnessChange,
  HarnessDefinition,
  HarnessExport,
  HarnessImportOptions,
  HarnessImportPreview,
  HarnessListing,
  HarnessPromptFile,
  HarnessRenameResult,
  HarnessSummary,
  HarnessWriteResult,
};

export interface HarnessManagementOptions {
  /** Workspace whose default Agent and settings apply; defaults to `process.cwd()`. */
  cwd?: string;
}

/** Whether the runtime in this process was reloaded because it uses an affected Agent. */
export interface HarnessReload {
  reloaded: boolean;
}

async function sdkCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HarnessManagementError) throw new AgentSdkError(error.code, error.message, { cause: error });
    if (error instanceof PersistentDataError) throw new AgentSdkError("harness", error.message, { cause: error });
    throw error;
  }
}

async function withReload<T extends { affected: string[] }>(operation: () => Promise<T>): Promise<T & HarnessReload> {
  const change = await sdkCall(operation);
  return { ...change, reloaded: await reloadRuntimeUsing(change.affected) };
}

const cwdOf = (options: HarnessManagementOptions) => options.cwd ?? process.cwd();

/** The built-in Agents and those in `harnesses`, each with its errors, and the workspace's default Agent. */
export function listHarnesses(options: HarnessManagementOptions = {}): Promise<HarnessListing> {
  return sdkCall(() => listDefinitions(cwdOf(options)));
}

/** One Agent's stored spec. Fails with `not_found` for an unknown name. */
export function readHarness(name: string): Promise<HarnessDefinition> {
  return sdkCall(() => readDefinition(name));
}

/**
 * Create or replace an Agent in `harnesses`. The spec is validated, and the
 * change is refused (code `harness`, nothing written) when it would break an
 * Agent: an invalid spec, an `extends` that is missing or forms a cycle, an
 * unreadable `file`. For `default` only the changes to the built-in default
 * are stored; a spec without any restores the built-in default.
 */
export function writeHarness(name: string, spec: unknown): Promise<HarnessWriteResult & HarnessReload> {
  return withReload(() => writeDefinition(name, spec));
}

/**
 * Write the text of an identity or prompt section to `~/.easy-agent/prompts/<name>`
 * (`name` ends in `.md`, no directories) and return the `file` reference for a
 * spec. Agents that already reference the file use the new text from their
 * next request.
 */
export function writeHarnessPrompt(name: string, text: string): Promise<HarnessPromptFile> {
  return sdkCall(() => writePromptFile(name, text));
}

/** Delete an Agent; `default` goes back to the built-in default. An Agent others extend is refused. */
export function deleteHarness(name: string): Promise<HarnessChange & { deleted: boolean } & HarnessReload> {
  return withReload(() => deleteDefinition(name));
}

/** Rename an Agent; Agents that extend it and the workspace's default Agent follow the new name. */
export function renameHarness(
  from: string,
  to: string,
  options: HarnessManagementOptions = {},
): Promise<HarnessRenameResult & HarnessReload> {
  return withReload(() => renameDefinition(from, to, cwdOf(options)));
}

/** One Agent as a single JSON document, its whole `extends` chain and its text files inline. */
export function exportHarness(name: string): Promise<HarnessExport> {
  return sdkCall(() => exportDefinition(name));
}

/** What an exported Agent would turn on in the workspace: tools, MCP servers, permission mode and rules. */
export function previewHarnessImport(
  data: unknown,
  options: HarnessManagementOptions = {},
): Promise<HarnessImportPreview> {
  return sdkCall(() => previewDefinition(cwdOf(options), data));
}

/** Write an exported Agent into `harnesses`; `fingerprint` comes from the preview the user confirmed. */
export function importHarness(
  data: unknown,
  options: HarnessImportOptions,
): Promise<HarnessWriteResult & HarnessReload> {
  return withReload(() => importDefinition(data, options));
}

/**
 * Set the Agent the workspace uses when none is selected (`harness` in its
 * local settings file), or go back to `default` with null. Runtimes started
 * in the workspace afterwards use it. Needs a trusted workspace.
 */
export function setProjectHarness(
  name: string | null,
  options: HarnessManagementOptions = {},
): Promise<{ name: string; path: string }> {
  return sdkCall(() => setProjectDefinition(cwdOf(options), name));
}

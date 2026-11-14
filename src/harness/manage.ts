/**
 * Agent management: list, read, write, rename, and delete the Agents in
 * `harnesses` of the user settings file, export one as a single JSON
 * document and import it again, and set the workspace's default Agent
 * (`harness` in the local settings file).
 *
 * Every change is one locked read-modify-write of the settings file: the
 * change is computed from the file as it is under the lock, so concurrent
 * writers (other processes too) never lose each other's Agents, and only the
 * `harnesses` key is replaced. Before anything is written, every Agent is
 * resolved against the new definitions; a change that leaves an Agent with an
 * error it did not have (an invalid spec, an `extends` that is missing or
 * forms a cycle, an unreadable `file`) is refused and the file stays as it
 * was.
 *
 * Specs have no credential fields (the strict schema rejects every other
 * key), so they are returned as stored; nothing else from the settings file
 * is returned.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { isProjectTrusted } from "../config/globalState.js";
import { loadSettingSources } from "../config/sources.js";
import { loadMcpConfigs } from "../services/mcp/config.js";
import { getLocalSettingsPath, getUserSettingsPath } from "../utils/paths.js";
import { atomicWriteFile } from "../utils/atomicFile.js";
import { readJsonSettingsFile, updateLocalSettings, updateUserSettings } from "../utils/settings.js";
import { listBuiltInComponents } from "./components.js";
import { HARNESS_KEYS } from "./keys.js";
import {
  harnessValue,
  MAX_TEXT_BYTES,
  type ResolvedHarness,
  resolveHarness,
  resolveHarnessFromInputs,
} from "./resolve.js";
import { selectionOffReason } from "./selection.js";
import { BUILT_IN_HARNESSES, HARNESS_NAME, type HarnessSpec, HarnessSpecSchema } from "./spec.js";

export type HarnessManagementErrorCode = "not_found" | "invalid_argument" | "harness" | "untrusted";

export class HarnessManagementError extends Error {
  readonly code: HarnessManagementErrorCode;

  constructor(code: HarnessManagementErrorCode, message: string) {
    super(message);
    this.name = "HarnessManagementError";
    this.code = code;
  }
}

export interface HarnessSummary {
  name: string;
  /** A built-in Agent (`default`); listed whether or not `harnesses` changes it. */
  builtIn: boolean;
  /** `harnesses` has an entry for it; for a built-in Agent, the changes made to it. */
  defined: boolean;
  description?: string;
  /** The Agent it extends; absent for `default`. */
  extends?: string;
  /** Agents that extend it, directly or through others. */
  dependents: string[];
  /** This workspace uses it when no Agent is selected. */
  projectDefault: boolean;
  /** Why it does not resolve; empty when it does. */
  errors: string[];
}

export interface HarnessListing {
  /** Built-in Agents first, then the others by name. */
  harnesses: HarnessSummary[];
  /** `harness` in this workspace's local settings file, when set. */
  projectDefault: { name: string; path: string; applied: boolean; reason?: string } | null;
  /** The user settings file that holds `harnesses`. */
  path: string;
}

export interface HarnessDefinition extends Omit<HarnessSummary, "projectDefault"> {
  /** The spec as stored; `{}` for a built-in Agent nobody changed. */
  spec: Record<string, unknown>;
  path: string;
}

export interface HarnessChange {
  name: string;
  /** The spec as stored now; null when the entry is gone (deleted, or `default` back to built-in). */
  spec: Record<string, unknown> | null;
  /** Agents whose settings can change: the one written and every Agent that extends it. */
  affected: string[];
}

export interface HarnessWriteResult extends HarnessChange {
  created: boolean;
}

export interface HarnessRenameResult extends HarnessChange {
  from: string;
  /** Agents whose `extends` now names the new name. */
  updatedExtends: string[];
  /** The workspace's default Agent was the old name and now is the new one. */
  updatedProjectDefault: boolean;
}

export const HARNESS_EXPORT_FORMAT = "easy-agent-harness";

/** One Agent as a single JSON document: its spec over the built-in default, text inline. */
export interface HarnessExport {
  format: typeof HARNESS_EXPORT_FORMAT;
  version: 1;
  name: string;
  spec: Record<string, unknown>;
}

export interface HarnessImportPreview {
  name: string;
  spec: Record<string, unknown>;
  /** An Agent with this name exists; importing under it needs `replace`. */
  exists: boolean;
  /** Built-in tools the Agent keeps in this workspace. */
  tools: string[];
  /** Configured MCP servers of this workspace the Agent starts. */
  mcpServers: string[];
  /** The permission mode it runs in here, and the rules the spec adds. */
  permissions: { mode: string; allow: string[]; ask: string[]; deny: string[] };
  /** Spec keys it sets, such as `sandbox.enabled`. */
  sets: string[];
  /** Why it would not resolve here; importing fails while there are any. */
  errors: string[];
  /** Pass to `importHarness` to confirm this exact content. */
  fingerprint: string;
}

export interface HarnessImportOptions {
  /** From the preview the user confirmed. */
  fingerprint: string;
  /** Name to import under; defaults to the document's name. */
  name?: string;
  /** Replace an Agent with the same name. */
  replace?: boolean;
}

// ─── Reading ────────────────────────────────────────────────────────────

type Definitions = Record<string, unknown>;
type SettingsObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBuiltIn = (name: string) => (BUILT_IN_HARNESSES as readonly string[]).includes(name);
const configDir = () => path.dirname(getUserSettingsPath());

function definitionsOf(settings: SettingsObject): Definitions {
  const value = settings.harnesses;
  if (value === undefined) return {};
  if (!isObject(value)) {
    throw new HarnessManagementError("harness", "harnesses in user settings must be an object of name → spec");
  }
  return { ...value };
}

async function readUserSettings(): Promise<SettingsObject> {
  const file = getUserSettingsPath();
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(file);
  if (parseError) throw new HarnessManagementError("harness", parseError);
  if (raw !== null && !isObject(raw))
    throw new HarnessManagementError("harness", `${file}: settings root must be a JSON object`);
  return raw ?? {};
}

function assertName(name: string): void {
  if (!HARNESS_NAME.test(name)) {
    throw new HarnessManagementError(
      "invalid_argument",
      `Not an Agent name: ${JSON.stringify(name)}. Names use letters, digits, ., _, and - (up to 64), starting with a letter or digit.`,
    );
  }
}

/** Resolve one Agent from the user settings file alone, with `definitions` in place of `harnesses`. */
function resolveFromUser(settings: SettingsObject, definitions: Definitions, name: string): ResolvedHarness {
  const raw = { ...settings, harnesses: definitions };
  return resolveHarnessFromInputs({
    layers: [{ source: "user", path: getUserSettingsPath(), raw }],
    workspaceTrusted: false,
    env: {},
    name,
    configDir: configDir(),
  });
}

function errorsOf(resolved: ResolvedHarness): string[] {
  return resolved.issues
    .filter((issue) => issue.level === "error")
    .map((issue) => {
      const where = issue.harness && issue.harness !== resolved.name ? `Agent "${issue.harness}"` : "";
      const at = issue.path ? `${where ? " " : ""}${issue.path}` : "";
      return `${where}${at}${where || at ? ": " : ""}${issue.message}`;
    });
}

/** The name an Agent extends, or undefined for `default` and for a spec that is not an object. */
function parentOf(definitions: Definitions, name: string): string | undefined {
  if (name === "default") return undefined;
  const spec = definitions[name];
  const parent = isObject(spec) && typeof spec.extends === "string" ? spec.extends.trim() : undefined;
  return parent || "default";
}

/** Agents that extend `name`, directly or through others, in name order. */
function dependentsOf(definitions: Definitions, name: string): string[] {
  const dependents: string[] = [];
  for (const candidate of Object.keys(definitions).sort()) {
    if (candidate === name) continue;
    const seen = new Set<string>([candidate]);
    for (let parent = parentOf(definitions, candidate); parent !== undefined; parent = parentOf(definitions, parent)) {
      if (parent === name) {
        dependents.push(candidate);
        break;
      }
      if (seen.has(parent)) break;
      seen.add(parent);
    }
  }
  return dependents;
}

function summaryOf(
  settings: SettingsObject,
  definitions: Definitions,
  name: string,
): Omit<HarnessSummary, "projectDefault"> {
  const spec = definitions[name];
  const description = isObject(spec) && typeof spec.description === "string" ? spec.description : undefined;
  const parent = parentOf(definitions, name);
  return {
    name,
    builtIn: isBuiltIn(name),
    defined: spec !== undefined,
    ...(description !== undefined ? { description } : {}),
    ...(parent !== undefined ? { extends: parent } : {}),
    dependents: dependentsOf(definitions, name),
    errors: errorsOf(resolveFromUser(settings, definitions, name)),
  };
}

async function readProjectDefault(cwd: string, definitions: Definitions): Promise<HarnessListing["projectDefault"]> {
  const sources = await loadSettingSources(cwd);
  const local = sources.find((source) => source.source === "local");
  const value = local?.raw?.harness;
  if (typeof value !== "string" || !value.trim()) return null;
  const name = value.trim();
  const file = local?.path ?? getLocalSettingsPath(cwd);
  if (!(await isProjectTrusted(cwd))) {
    return { name, path: file, applied: false, reason: "workspace is not trusted" };
  }
  if (!Object.hasOwn(definitions, name) && !isBuiltIn(name)) {
    return { name, path: file, applied: false, reason: `no Agent named "${name}"; the workspace uses default` };
  }
  return { name, path: file, applied: true };
}

/** Every Agent: the built-in ones and those in `harnesses`, with the workspace's default Agent. */
export async function listHarnesses(cwd: string): Promise<HarnessListing> {
  const settings = await readUserSettings();
  const definitions = definitionsOf(settings);
  const projectDefault = await readProjectDefault(cwd, definitions);
  const effective = projectDefault?.applied ? projectDefault.name : "default";
  const names = [
    ...BUILT_IN_HARNESSES,
    ...Object.keys(definitions)
      .filter((name) => !isBuiltIn(name))
      .sort(),
  ];
  return {
    harnesses: names.map((name) => ({ ...summaryOf(settings, definitions, name), projectDefault: name === effective })),
    projectDefault,
    path: getUserSettingsPath(),
  };
}

/** One Agent's stored spec. Fails with `not_found` for a name no Agent has. */
export async function readHarness(name: string): Promise<HarnessDefinition> {
  const settings = await readUserSettings();
  const definitions = definitionsOf(settings);
  if (!Object.hasOwn(definitions, name) && !isBuiltIn(name)) {
    throw new HarnessManagementError("not_found", `No Agent named "${name}".`);
  }
  const spec = definitions[name];
  return {
    ...summaryOf(settings, definitions, name),
    spec: isObject(spec) ? spec : {},
    path: getUserSettingsPath(),
  };
}

// ─── Writing ────────────────────────────────────────────────────────────

const canonical = (value: unknown): string => JSON.stringify(sortKeys(value));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

/** Errors of every Agent in `definitions`, keyed by Agent name. */
function errorsByAgent(settings: SettingsObject, definitions: Definitions): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const name of new Set([...BUILT_IN_HARNESSES, ...Object.keys(definitions)])) {
    result.set(name, new Set(errorsOf(resolveFromUser(settings, definitions, name))));
  }
  return result;
}

/**
 * Change `harnesses` under the settings file lock. `change` gets the current
 * definitions and returns the new ones; it may throw to refuse. The new
 * definitions are written only when no Agent gains an error.
 */
async function changeDefinitions<T>(
  change: (definitions: Definitions, settings: SettingsObject) => { definitions: Definitions; result: T },
): Promise<T> {
  let outcome: T | undefined;
  await updateUserSettings((settings) => {
    const before = definitionsOf(settings);
    const { definitions: after, result } = change({ ...before }, settings);
    const previous = errorsByAgent(settings, before);
    const problems: string[] = [];
    for (const [name, errors] of errorsByAgent(settings, after)) {
      for (const error of errors) {
        if (!previous.get(name)?.has(error)) problems.push(`Agent "${name}": ${error}`);
      }
    }
    if (problems.length > 0) {
      throw new HarnessManagementError("harness", `Not saved; the change would break an Agent: ${problems.join("; ")}`);
    }
    outcome = result;
    return { harnesses: Object.keys(after).length > 0 ? after : undefined };
  });
  return outcome as T;
}

function parseSpec(name: string, spec: unknown): HarnessSpec {
  const parsed = HarnessSpecSchema.safeParse(spec);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.join(".");
    return where ? `${where}: ${issue.message}` : issue.message;
  });
  throw new HarnessManagementError("harness", `Agent "${name}" is not a valid spec: ${problems.join("; ")}`);
}

function valueAt(spec: unknown, keyPath: string): unknown {
  let current = spec;
  for (const part of keyPath.split(".")) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function deleteAt(spec: Record<string, unknown>, keyPath: string): void {
  const parts = keyPath.split(".");
  const parents: Record<string, unknown>[] = [spec];
  for (const part of parts.slice(0, -1)) {
    const next = parents[parents.length - 1]![part];
    if (!isObject(next)) return;
    parents.push(next);
  }
  delete parents[parents.length - 1]![parts[parts.length - 1]!];
  for (let i = parents.length - 1; i > 0; i--) {
    if (Object.keys(parents[i]!).length === 0) delete parents[i - 1]![parts[i - 1]!];
  }
}

/**
 * `harnesses.default` keeps only what differs from the built-in default and
 * the top-level user settings: a value equal to what the Agent would get
 * without it is dropped, as is `extends: "default"`.
 */
function changesToDefault(spec: HarnessSpec, settings: SettingsObject): Record<string, unknown> {
  const base = resolveFromUser(settings, {}, "default");
  const stored = structuredClone(spec) as Record<string, unknown>;
  delete stored.extends;
  for (const key of HARNESS_KEYS) {
    const value = valueAt(stored, key.path);
    if (value === undefined) continue;
    const inherited = base.values[key.path]?.value;
    const same =
      key.merge === "union"
        ? Array.isArray(value) && value.every((item) => Array.isArray(inherited) && inherited.includes(item))
        : canonical(value) === canonical(inherited);
    if (same) deleteAt(stored, key.path);
  }
  return stored;
}

/**
 * Create or replace an Agent. For `default`, only the changes to the
 * built-in default are stored, and a spec without any removes the entry.
 */
export function writeHarness(name: string, spec: unknown): Promise<HarnessWriteResult> {
  return putHarness(name, spec, false);
}

async function putHarness(name: string, spec: unknown, createOnly: boolean): Promise<HarnessWriteResult> {
  assertName(name);
  const parsed = parseSpec(name, spec);
  if (name === "default" && parsed.extends !== undefined && parsed.extends !== "default") {
    throw new HarnessManagementError(
      "harness",
      'harnesses.default extends only the built-in default; remove "extends".',
    );
  }
  return changeDefinitions((definitions, settings) => {
    const created = !Object.hasOwn(definitions, name);
    if (createOnly && (!created || isBuiltIn(name))) {
      throw new HarnessManagementError(
        "invalid_argument",
        `An Agent named "${name}" already exists; import under another name or replace it.`,
      );
    }
    const stored = name === "default" ? changesToDefault(parsed, settings) : (parsed as Record<string, unknown>);
    const keep = name !== "default" || Object.keys(stored).length > 0;
    if (keep) definitions[name] = stored;
    else delete definitions[name];
    return {
      definitions,
      result: {
        name,
        spec: keep ? stored : null,
        created: created && keep,
        affected: [name, ...dependentsOf(definitions, name)],
      },
    };
  });
}

/** A prompt file name: letters, digits, `.`, `_`, and `-`, ending in `.md`; no directories. */
export const PROMPT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,96}\.md$/;

export interface HarnessPromptFile {
  /** The reference to put in a spec (`{ "file": ... }`); it resolves against the user settings directory. */
  file: string;
  path: string;
}

/**
 * Write the text of an identity or prompt section to `prompts/<name>` next to
 * the user settings file, replacing what is there. The Agents that reference
 * it read the new text before their next request. Writing the file does not
 * change any Agent; reference it from a spec with `harness/write`.
 */
export async function writeHarnessPrompt(name: string, text: string): Promise<HarnessPromptFile> {
  if (!PROMPT_FILE_NAME.test(name)) {
    throw new HarnessManagementError(
      "invalid_argument",
      `Not a prompt file name: ${JSON.stringify(name)}. Use letters, digits, ., _, and - ending in .md, without directories.`,
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    throw new HarnessManagementError("invalid_argument", `Prompt text is larger than ${MAX_TEXT_BYTES} bytes.`);
  }
  const dir = path.join(configDir(), "prompts");
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await atomicWriteFile(target, text);
  return { file: `prompts/${name}`, path: target };
}

/**
 * Delete an Agent. Deleting `default` restores the built-in default. An
 * Agent that others extend is refused; change their `extends` first.
 */
export async function deleteHarness(name: string): Promise<HarnessChange & { deleted: boolean }> {
  assertName(name);
  return changeDefinitions<HarnessChange & { deleted: boolean }>((definitions) => {
    if (!Object.hasOwn(definitions, name)) {
      if (isBuiltIn(name)) return { definitions, result: { name, spec: null, deleted: false, affected: [] } };
      throw new HarnessManagementError("not_found", `No Agent named "${name}".`);
    }
    const affected = [name, ...dependentsOf(definitions, name)];
    if (name !== "default") {
      const children = Object.keys(definitions).filter(
        (other) => other !== name && parentOf(definitions, other) === name,
      );
      if (children.length > 0) {
        throw new HarnessManagementError(
          "harness",
          `Agent "${name}" is extended by ${children.map((child) => `"${child}"`).join(", ")}; change their extends first.`,
        );
      }
    }
    delete definitions[name];
    return { definitions, result: { name, spec: null, deleted: true, affected } };
  });
}

/**
 * Rename an Agent. Agents that extend it follow the new name, and so does
 * the default Agent of the workspace in `cwd` when it named the old one.
 */
export async function renameHarness(from: string, to: string, cwd: string): Promise<HarnessRenameResult> {
  assertName(from);
  assertName(to);
  if (isBuiltIn(from))
    throw new HarnessManagementError("invalid_argument", `The built-in Agent "${from}" keeps its name.`);
  const result = await changeDefinitions((definitions) => {
    if (!Object.hasOwn(definitions, from)) throw new HarnessManagementError("not_found", `No Agent named "${from}".`);
    if (from === to) {
      return {
        definitions,
        result: { name: to, from, spec: definitions[to] as Record<string, unknown>, affected: [], updatedExtends: [] },
      };
    }
    if (isBuiltIn(to) || Object.hasOwn(definitions, to)) {
      throw new HarnessManagementError("invalid_argument", `An Agent named "${to}" already exists.`);
    }
    const dependents = dependentsOf(definitions, from);
    const next: Definitions = {};
    const updatedExtends: string[] = [];
    for (const [name, spec] of Object.entries(definitions)) {
      let value = spec;
      if (name !== from && isObject(spec) && typeof spec.extends === "string" && spec.extends.trim() === from) {
        value = { ...spec, extends: to };
        updatedExtends.push(name);
      }
      next[name === from ? to : name] = value;
    }
    return {
      definitions: next,
      result: {
        name: to,
        from,
        spec: next[to] as Record<string, unknown>,
        affected: [from, to, ...dependents],
        updatedExtends,
      },
    };
  });
  const projectDefault = from === to ? null : await readProjectDefault(cwd, {});
  const updatedProjectDefault = projectDefault?.name === from && (await isProjectTrusted(cwd));
  if (updatedProjectDefault) await updateLocalSettings(cwd, { harness: to });
  return { ...result, updatedProjectDefault };
}

// ─── Workspace default ──────────────────────────────────────────────────

/**
 * Set the Agent this workspace uses when none is selected, or go back to
 * `default` with null. Written to the local settings file, which is not
 * committed. Needs a trusted workspace, since the key is ignored otherwise.
 * Runtimes pick it up when they start.
 */
export async function setProjectHarness(cwd: string, name: string | null): Promise<{ name: string; path: string }> {
  if (!(await isProjectTrusted(cwd))) {
    throw new HarnessManagementError(
      "untrusted",
      "This workspace is not trusted, so a default Agent set here would be ignored. Trust the workspace first.",
    );
  }
  const file = getLocalSettingsPath(cwd);
  if (name === null || name === "default") {
    await updateLocalSettings(cwd, { harness: undefined });
    return { name: "default", path: file };
  }
  assertName(name);
  const settings = await readUserSettings();
  const definitions = definitionsOf(settings);
  if (!Object.hasOwn(definitions, name) && !isBuiltIn(name)) {
    throw new HarnessManagementError("not_found", `No Agent named "${name}".`);
  }
  const errors = errorsOf(resolveFromUser(settings, definitions, name));
  if (errors.length > 0) {
    throw new HarnessManagementError("harness", `Agent "${name}" does not resolve: ${errors.join("; ")}`);
  }
  await updateLocalSettings(cwd, { harness: name });
  return { name, path: file };
}

// ─── Export and import ──────────────────────────────────────────────────

const HarnessExportSchema = z
  .object({
    format: z.literal(HARNESS_EXPORT_FORMAT),
    version: z.literal(1),
    name: z.string(),
    spec: z.unknown(),
  })
  .loose();

/** Inline text in the form the spec accepts. */
function inlineText(keyPath: string, value: unknown): unknown {
  if (keyPath === "prompt.identity" && isObject(value) && typeof value.text === "string") return { text: value.text };
  if (keyPath === "prompt.sections" && isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([section, entry]) => {
        if (!isObject(entry)) return [section, entry];
        const { file: _file, ...rest } = entry;
        return [section, rest];
      }),
    );
  }
  return value;
}

/**
 * One Agent as a single JSON document. The spec holds every value its
 * `extends` chain sets (the user's `default` changes included), so it
 * resolves the same on another machine; `file` references are replaced by
 * their text.
 */
export async function exportHarness(name: string): Promise<HarnessExport> {
  const settings = await readUserSettings();
  const definitions = definitionsOf(settings);
  if (!Object.hasOwn(definitions, name) && !isBuiltIn(name)) {
    throw new HarnessManagementError("not_found", `No Agent named "${name}".`);
  }
  const resolved = resolveFromUser(settings, definitions, name);
  const errors = errorsOf(resolved);
  if (errors.length > 0)
    throw new HarnessManagementError("harness", `Agent "${name}" does not resolve: ${errors.join("; ")}`);
  const spec: Record<string, unknown> = {};
  for (
    let chainName = name as string | undefined;
    chainName !== undefined;
    chainName = parentOf(definitions, chainName)
  ) {
    const entry = definitions[chainName];
    if (isObject(entry) && typeof entry.description === "string") {
      spec.description = entry.description;
      break;
    }
  }
  for (const key of HARNESS_KEYS) {
    const fromSpec = resolved.values[key.path]?.contributions.find((contribution) => contribution.source === "harness");
    if (fromSpec === undefined || fromSpec.value === undefined) continue;
    const parts = key.path.split(".");
    let target = spec;
    for (const part of parts.slice(0, -1)) {
      if (!isObject(target[part])) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]!] = structuredClone(inlineText(key.path, fromSpec.value));
  }
  return { format: HARNESS_EXPORT_FORMAT, version: 1, name, spec };
}

function fileReferences(spec: HarnessSpec): string[] {
  const found: string[] = [];
  const identity = spec.prompt?.identity;
  if (isObject(identity) && "file" in identity) found.push("prompt.identity");
  for (const [section, entry] of Object.entries(spec.prompt?.sections ?? {})) {
    if (isObject(entry) && entry.file !== undefined) found.push(`prompt.sections.${section}`);
  }
  return found;
}

function parseExport(data: unknown): { name: string; spec: HarnessSpec; fingerprint: string } {
  const parsed = HarnessExportSchema.safeParse(data);
  if (!parsed.success) {
    throw new HarnessManagementError(
      "invalid_argument",
      `Not an exported Agent: expected { "format": "${HARNESS_EXPORT_FORMAT}", "version": 1, "name", "spec" }.`,
    );
  }
  assertName(parsed.data.name);
  const spec = parseSpec(parsed.data.name, parsed.data.spec);
  const files = fileReferences(spec);
  if (files.length > 0) {
    throw new HarnessManagementError(
      "invalid_argument",
      `An imported Agent carries its text inline; ${files.join(", ")} reads a file instead.`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(canonical({ name: parsed.data.name, spec }))
    .digest("hex")
    .slice(0, 16);
  return { name: parsed.data.name, spec, fingerprint };
}

function specKeysSet(spec: HarnessSpec): string[] {
  return HARNESS_KEYS.filter((key) => valueAt(spec, key.path) !== undefined).map((key) => key.path);
}

/**
 * What an exported Agent would do in the workspace in `cwd`, before it is
 * imported: the tools and MCP servers it keeps, its permission mode and
 * rules, and every key it sets. Show it to the user and pass the
 * fingerprint to `importHarness` once they confirm.
 */
export async function previewHarnessImport(cwd: string, data: unknown): Promise<HarnessImportPreview> {
  const { name, spec, fingerprint } = parseExport(data);
  const [resolved, settings, mcp] = await Promise.all([
    resolveHarness({ cwd, spec }),
    readUserSettings(),
    loadMcpConfigs(cwd, { quiet: true }),
  ]);
  const definitions = definitionsOf(settings);
  return {
    name,
    spec: spec as Record<string, unknown>,
    exists: Object.hasOwn(definitions, name) || isBuiltIn(name),
    tools: listBuiltInComponents(resolved)
      .filter((component) => component.kind === "tool" && component.enabled)
      .map((component) => component.name),
    mcpServers: Object.keys(mcp.servers)
      .filter((server) => selectionOffReason(resolved, "mcpServers", server) === undefined)
      .sort(),
    permissions: {
      mode: harnessValue<string>(resolved, "permissions.mode"),
      allow: [...(spec.permissions?.allow ?? [])],
      ask: [...(spec.permissions?.ask ?? [])],
      deny: [...(spec.permissions?.deny ?? [])],
    },
    sets: specKeysSet(spec),
    errors: errorsOf(resolved),
    fingerprint,
  };
}

/** Import an exported Agent into `harnesses` once the user confirmed its preview. */
export async function importHarness(data: unknown, options: HarnessImportOptions): Promise<HarnessWriteResult> {
  const { name: exported, spec, fingerprint } = parseExport(data);
  if (options.fingerprint !== fingerprint) {
    throw new HarnessManagementError(
      "invalid_argument",
      "The Agent differs from the preview that was confirmed; preview it again.",
    );
  }
  return putHarness(options.name ?? exported, spec, !options.replace);
}

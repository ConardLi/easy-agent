/**
 * Resolve which value every Harness key takes, and why.
 *
 * Layers, lowest first:
 *   built-in default → user settings (top-level keys) → the selected Agent's
 *   spec (`harnesses.<name>`, with its `extends` chain) → project settings →
 *   local settings → environment → command-line flags and SDK → managed
 *   policy.
 *
 * Settings layers are read with the same trust rules the loaders use today:
 * project and local values of a `trusted` key apply only in a trusted
 * workspace, `user` keys ignore them entirely, and `any` keys (which can only
 * remove capabilities, such as deny rules) are read everywhere. A value that
 * a layer sets but may not apply is kept in `ignored` with the reason.
 *
 * The result is a frozen snapshot. A runtime resolves one when it starts and
 * installs it (see `active.ts`); `harness show` and the desktop Agent views
 * read the same data.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProjectTrusted } from "../config/globalState.js";
import { loadSettingSources, type LoadedSource, type SettingSource } from "../config/sources.js";
import { getUserSettingsPath } from "../utils/paths.js";
import { HARNESS_KEYS, type HarnessKey, type HarnessLayerSource, type HarnessSettingsInput } from "./keys.js";
import { BUILT_IN_HARNESSES, HARNESS_NAME, HarnessSpecSchema, type HarnessSpec, type TextSource } from "./spec.js";

export interface HarnessContribution {
  source: HarnessLayerSource;
  /** Settings key, environment variable, harness name, or flag that supplied the value. */
  detail?: string;
  value: unknown;
}

export interface HarnessIgnoredValue extends HarnessContribution {
  reason: string;
}

export interface ResolvedHarnessValue {
  value: unknown;
  /** Layer the value came from; for merged rule lists, the last layer that added rules. */
  source: HarnessLayerSource;
  detail?: string;
  /** Whether this build reads the key. */
  applied: boolean;
  contributions: readonly HarnessContribution[];
  ignored: readonly HarnessIgnoredValue[];
  /** A project or local setting replaced the value the Agent's spec gave. */
  overridesHarness?: { harness: string; value: unknown };
}

export interface HarnessIssue {
  level: "error" | "warning";
  message: string;
  harness?: string;
  path?: string;
}

export interface ResolvedHarness {
  /** The requested Agent, or `(inline)` for a spec passed directly. */
  name: string;
  /**
   * Set when `name` was not selected explicitly: the workspace's default
   * Agent (`harness` in the local settings file), or the Agent a saved
   * session last ran with.
   */
  selectedBy?: { source: "local"; path: string | null } | { source: "session"; sessionId: string };
  /** Specs applied over the built-in default, base first. */
  chain: readonly string[];
  values: Readonly<Record<string, ResolvedHarnessValue>>;
  issues: readonly HarnessIssue[];
  /** Hash of every resolved value; changes whenever one does. */
  hash: string;
}

export interface HarnessSettingsLayer {
  source: SettingSource;
  path: string | null;
  raw: Record<string, unknown> | null;
}

export interface HarnessInputs {
  /** Settings layers in priority order, lowest first (user, project, local, flag, policy). */
  layers: readonly HarnessSettingsLayer[];
  workspaceTrusted: boolean;
  env: NodeJS.ProcessEnv;
  /** `--agent-teams` was passed. */
  agentTeamsFlag?: boolean;
  /** Agent to resolve; defaults to the workspace's default Agent, then `default`. */
  name?: string;
  /** Recorded in the result with `name`: the workspace default chose that name earlier. */
  selectedBy?: ResolvedHarness["selectedBy"];
  /** A spec passed directly (CLI file or SDK object), resolved over its `extends`. */
  spec?: unknown;
  /** Reads a text file referenced by the spec. Throws when it cannot. */
  readText?: (file: string) => string;
  /** Base for relative `file` paths. */
  configDir?: string;
  home?: string;
}

const INLINE = "(inline)";
const MAX_TEXT_BYTES = 256 * 1024;
const SETTINGS_REASON = {
  untrusted: "workspace is not trusted",
  userOnly: "only user settings, flags, and managed policy can set this",
} as const;

// ─── Spec chain ─────────────────────────────────────────────────────────

interface ChainEntry {
  name: string;
  spec: HarnessSpec;
}

function readHarnessDefinitions(inputs: HarnessInputs, issues: HarnessIssue[]): Record<string, unknown> {
  let definitions: Record<string, unknown> = {};
  for (const layer of inputs.layers) {
    const value = layer.raw?.harnesses;
    if (value === undefined) continue;
    if (layer.source !== "user") {
      issues.push({
        level: "warning",
        message: `harnesses in ${layer.source} settings${layer.path ? ` (${layer.path})` : ""} are ignored; Agents are defined only in the user settings file`,
      });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ level: "error", message: "harnesses in user settings must be an object of name → spec" });
      continue;
    }
    definitions = value as Record<string, unknown>;
  }
  return definitions;
}

function parseSpec(name: string, raw: unknown, issues: HarnessIssue[]): HarnessSpec | undefined {
  const result = HarnessSpecSchema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const where = issue.path.join(".");
    issues.push({ level: "error", harness: name, ...(where ? { path: where } : {}), message: issue.message });
  }
  return undefined;
}

/**
 * The workspace's default Agent: `harness` in the local settings file of a
 * trusted workspace. The key in any other layer, or in an untrusted
 * workspace, is ignored with a warning. A name no Agent has falls back to
 * `default` with a warning, since the Agent may have been deleted since.
 */
export function projectHarnessSelection(
  inputs: Pick<HarnessInputs, "layers" | "workspaceTrusted">,
  definitions: Readonly<Record<string, unknown>>,
  issues: HarnessIssue[] = [],
): { name: string; path: string | null } | undefined {
  let selected: { name: string; path: string | null } | undefined;
  for (const layer of inputs.layers) {
    const value = layer.raw?.harness;
    if (value === undefined) continue;
    const where = `${layer.source} settings${layer.path ? ` (${layer.path})` : ""}`;
    if (layer.source !== "local") {
      issues.push({
        level: "warning",
        message: `harness in ${where} is ignored; the workspace's default Agent is set only in the local settings file`,
      });
    } else if (!inputs.workspaceTrusted) {
      issues.push({ level: "warning", message: `harness in ${where} is ignored: ${SETTINGS_REASON.untrusted}` });
    } else if (typeof value === "string" && value.trim()) {
      selected = { name: value.trim(), path: layer.path };
    }
  }
  if (!selected) return undefined;
  if (
    !Object.hasOwn(definitions, selected.name) &&
    !(BUILT_IN_HARNESSES as readonly string[]).includes(selected.name)
  ) {
    issues.push({
      level: "warning",
      harness: selected.name,
      message: `the workspace's default Agent "${selected.name}"${selected.path ? ` (${selected.path})` : ""} does not exist; using default`,
    });
    return undefined;
  }
  return selected;
}

function buildChain(
  inputs: HarnessInputs,
  issues: HarnessIssue[],
): { name: string; chain: ChainEntry[]; selectedBy?: ResolvedHarness["selectedBy"] } {
  const definitions = readHarnessDefinitions(inputs, issues);
  const builtIn = new Set<string>(BUILT_IN_HARNESSES);

  const resolveName = (name: string, visiting: string[]): ChainEntry[] => {
    if (visiting.includes(name)) {
      issues.push({ level: "error", harness: name, message: `extends cycle: ${[...visiting, name].join(" → ")}` });
      return [];
    }
    const raw = definitions[name];
    if (raw === undefined) {
      if (!builtIn.has(name)) issues.push({ level: "error", harness: name, message: `no Agent named "${name}"` });
      return [];
    }
    if (!HARNESS_NAME.test(name)) {
      issues.push({ level: "error", harness: name, message: "names use letters, digits, ., _, and - (up to 64)" });
      return [];
    }
    const spec = parseSpec(name, raw, issues);
    if (!spec) return [];
    if (name === "default" && spec.extends !== undefined && spec.extends !== "default") {
      issues.push({
        level: "error",
        harness: name,
        path: "extends",
        message: "harnesses.default extends only the built-in default",
      });
      return [];
    }
    // The user's `default` overrides the built-in one; it has nothing else to extend.
    const parent = name === "default" ? undefined : (spec.extends ?? "default");
    return [...(parent ? resolveName(parent, [...visiting, name]) : []), { name, spec }];
  };

  if (inputs.spec !== undefined) {
    const spec = parseSpec(INLINE, inputs.spec, issues);
    if (!spec) return { name: INLINE, chain: [] };
    return { name: INLINE, chain: [...resolveName(spec.extends ?? "default", [INLINE]), { name: INLINE, spec }] };
  }
  if (inputs.name !== undefined) {
    return {
      name: inputs.name,
      chain: resolveName(inputs.name, []),
      ...(inputs.selectedBy ? { selectedBy: inputs.selectedBy } : {}),
    };
  }
  const project = projectHarnessSelection(inputs, definitions, issues);
  if (!project) return { name: "default", chain: resolveName("default", []) };
  return {
    name: project.name,
    chain: resolveName(project.name, []),
    selectedBy: { source: "local", path: project.path },
  };
}

function valueAt(spec: unknown, dotted: string): unknown {
  let current = spec;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The last spec in the chain that sets `path`, with its value. */
function specValue(chain: readonly ChainEntry[], keyPath: string): { harness: string; value: unknown } | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const value = valueAt(chain[i]!.spec, keyPath);
    if (value !== undefined) return { harness: chain[i]!.name, value };
  }
  return undefined;
}

// ─── Text files ─────────────────────────────────────────────────────────

function resolveFile(file: string, inputs: HarnessInputs): string {
  const home = inputs.home ?? os.homedir();
  if (file === "~") return home;
  if (file.startsWith("~/") || file.startsWith("~\\")) return path.join(home, file.slice(2));
  if (path.isAbsolute(file)) return file;
  return path.join(inputs.configDir ?? path.join(home, ".easy-agent"), file);
}

function defaultReadText(file: string): string {
  if (statSync(file).size > MAX_TEXT_BYTES) throw new Error(`larger than ${MAX_TEXT_BYTES} bytes`);
  return readFileSync(file, "utf8");
}

function loadText(
  source: TextSource,
  where: { harness: string; path: string },
  inputs: HarnessInputs,
  issues: HarnessIssue[],
): { text: string; file?: string } | undefined {
  if (typeof source === "string") return { text: source };
  if ("text" in source) return { text: source.text };
  const file = resolveFile(source.file, inputs);
  try {
    return { text: (inputs.readText ?? defaultReadText)(file), file };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    issues.push({ level: "error", ...where, message: `cannot read ${file}: ${reason}` });
    return undefined;
  }
}

/** Replace `file` references in text-valued keys with the text. */
function loadSpecText(
  keyPath: string,
  found: { harness: string; value: unknown },
  inputs: HarnessInputs,
  issues: HarnessIssue[],
): unknown {
  const where = { harness: found.harness, path: keyPath };
  if (keyPath === "prompt.identity") return loadText(found.value as TextSource, where, inputs, issues);
  if (keyPath === "prompt.sections") {
    const sections: Record<string, unknown> = {};
    for (const [name, section] of Object.entries(found.value as Record<string, unknown>)) {
      if (section && typeof section === "object" && "file" in section && typeof section.file === "string") {
        const { file: _file, ...rest } = section as { file: string };
        const loaded = loadText({ file: section.file }, { ...where, path: `${keyPath}.${name}` }, inputs, issues);
        sections[name] = loaded ? { ...rest, text: loaded.text, file: loaded.file } : section;
      } else sections[name] = section;
    }
    return sections;
  }
  return found.value;
}

// ─── Resolution ─────────────────────────────────────────────────────────

interface Candidate extends HarnessContribution {
  ignoredReason?: string;
}

function settingsCandidate(
  input: HarnessSettingsInput,
  layer: HarnessSettingsLayer,
  workspaceTrusted: boolean,
): Candidate | undefined {
  if (!layer.raw) return undefined;
  const value = input.read(layer.raw);
  if (value === undefined) return undefined;
  const projectScoped = layer.source === "project" || layer.source === "local";
  let ignoredReason: string | undefined;
  if (projectScoped && input.scope === "user") ignoredReason = SETTINGS_REASON.userOnly;
  else if (projectScoped && input.scope === "trusted" && !workspaceTrusted) ignoredReason = SETTINGS_REASON.untrusted;
  return { source: layer.source, detail: input.key, value, ...(ignoredReason ? { ignoredReason } : {}) };
}

function resolveKey(
  key: HarnessKey,
  chain: readonly ChainEntry[],
  inputs: HarnessInputs,
  issues: HarnessIssue[],
): ResolvedHarnessValue {
  const layer = (source: SettingSource) => inputs.layers.find((candidate) => candidate.source === source);
  const envRead = key.env?.read(inputs.env);
  const envCandidate: Candidate | undefined = envRead
    ? "invalid" in envRead
      ? { source: "environment", detail: envRead.name, value: envRead.raw, ignoredReason: envRead.invalid }
      : { source: "environment", detail: envRead.name, value: envRead.value }
    : undefined;

  const found = specValue(chain, key.path);
  const harnessCandidate: Candidate | undefined = found
    ? { source: "harness", detail: found.harness, value: loadSpecText(key.path, found, inputs, issues) }
    : undefined;

  const settingsAt = (input: HarnessSettingsInput | undefined, source: SettingSource): Candidate | undefined => {
    const settingsLayer = input ? layer(source) : undefined;
    return settingsLayer ? settingsCandidate(input!, settingsLayer, inputs.workspaceTrusted) : undefined;
  };
  const ordered = (input: HarnessSettingsInput | undefined, withHarness: boolean): Candidate[] =>
    [
      settingsAt(input, "user"),
      withHarness ? harnessCandidate : undefined,
      settingsAt(input, "project"),
      settingsAt(input, "local"),
      key.env?.position === "override" ? envCandidate : undefined,
      settingsAt(input, "flag"),
      key.argvAgentTeams && inputs.agentTeamsFlag
        ? ({ source: "flag", detail: "--agent-teams", value: true } satisfies Candidate)
        : undefined,
      settingsAt(input, "policy"),
      key.env?.position === "top" ? envCandidate : undefined,
    ].filter((candidate): candidate is Candidate => candidate !== undefined);

  let candidates = ordered(key.settings, true);
  if (key.fallbackSettings && !candidates.some((candidate) => !candidate.ignoredReason)) {
    candidates = [...candidates, ...ordered(key.fallbackSettings, false)];
  }

  const base: HarnessContribution =
    key.env?.position === "default" && envCandidate && !envCandidate.ignoredReason
      ? envCandidate
      : { source: "built-in", value: key.defaultValue };
  const accepted = candidates.filter((candidate) => !candidate.ignoredReason);
  const ignored = candidates
    .filter((candidate) => candidate.ignoredReason)
    .map(({ ignoredReason, ...rest }) => ({ ...rest, reason: ignoredReason! }));
  const contributions = [base, ...accepted].map(({ source, detail, value }) => ({
    source,
    ...(detail ? { detail } : {}),
    value,
  }));

  let resolved: Pick<ResolvedHarnessValue, "value" | "source" | "detail">;
  if (key.merge === "union") {
    const merged: string[] = [];
    for (const contribution of contributions) {
      for (const item of (contribution.value as string[] | undefined) ?? [])
        if (!merged.includes(item)) merged.push(item);
    }
    const last = [...contributions].reverse().find((c) => Array.isArray(c.value) && c.value.length > 0) ?? base;
    resolved = { value: merged, source: last.source, ...(last.detail ? { detail: last.detail } : {}) };
  } else {
    const winner = contributions[contributions.length - 1]!;
    resolved = { value: winner.value, source: winner.source, ...(winner.detail ? { detail: winner.detail } : {}) };
  }

  if (!key.applied && accepted.length > 0) {
    const setBy = accepted.map((c) => (c.source === "harness" ? `Agent "${c.detail}"` : c.source)).join(", ");
    issues.push({
      level: "warning",
      path: key.path,
      message: `${key.path} is set by ${setBy}, but this build does not apply it yet`,
    });
  }

  const overridesHarness =
    key.merge === "replace" && harnessCandidate && (resolved.source === "project" || resolved.source === "local")
      ? { harness: harnessCandidate.detail!, value: harnessCandidate.value }
      : undefined;

  return {
    ...resolved,
    applied: key.applied,
    contributions,
    ignored,
    ...(overridesHarness ? { overridesHarness } : {}),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Resolve a harness from already-loaded inputs. Pure apart from reading referenced text files. */
export function resolveHarnessFromInputs(inputs: HarnessInputs): ResolvedHarness {
  const issues: HarnessIssue[] = [];
  const { name, chain, selectedBy } = buildChain(inputs, issues);
  const values: Record<string, ResolvedHarnessValue> = {};
  for (const key of HARNESS_KEYS) values[key.path] = resolveKey(key, chain, inputs, issues);
  if (values["trace.level"]?.value === "full") {
    issues.push({
      level: "warning",
      path: "trace.level",
      message: "trace.level full is not available yet; requests are recorded at summary level",
    });
  }
  const effective = Object.fromEntries(Object.entries(values).map(([keyPath, entry]) => [keyPath, entry.value]));
  const hash = createHash("sha256")
    .update(JSON.stringify(sortKeys(effective)))
    .digest("hex")
    .slice(0, 16);
  return deepFreeze({
    name,
    ...(selectedBy ? { selectedBy } : {}),
    chain: chain.map((entry) => entry.name),
    values,
    issues,
    hash,
  });
}

export interface ResolveHarnessOptions {
  cwd: string;
  name?: string;
  spec?: unknown;
  env?: NodeJS.ProcessEnv;
  selectedBy?: ResolvedHarness["selectedBy"];
}

const hasAgentTeamsFlag = () => process.argv.includes("--agent-teams");

/** Resolve a harness for a workspace from its settings files, trust decision, environment, and flags. */
export async function resolveHarness(options: ResolveHarnessOptions): Promise<ResolvedHarness> {
  const [sources, workspaceTrusted] = await Promise.all([
    loadSettingSources(options.cwd),
    isProjectTrusted(options.cwd),
  ]);
  return resolveHarnessFromInputs({
    layers: sources.map(({ source, path: file, raw }: LoadedSource) => ({ source, path: file, raw })),
    workspaceTrusted,
    env: options.env ?? process.env,
    agentTeamsFlag: hasAgentTeamsFlag(),
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.spec !== undefined ? { spec: options.spec } : {}),
    ...(options.selectedBy ? { selectedBy: options.selectedBy } : {}),
    configDir: path.dirname(getUserSettingsPath()),
  });
}

/**
 * The workspace's default Agent for `cwd`, and the warnings about the
 * `harness` key (set outside the local file, untrusted workspace, unknown
 * name). Undefined when the workspace sets none that applies.
 */
export async function resolveProjectHarness(
  cwd: string,
): Promise<{ selection?: { name: string; path: string | null }; issues: HarnessIssue[] }> {
  const [sources, workspaceTrusted] = await Promise.all([loadSettingSources(cwd), isProjectTrusted(cwd)]);
  const layers = sources.map(({ source, path: file, raw }: LoadedSource) => ({ source, path: file, raw }));
  const issues: HarnessIssue[] = [];
  const definitions = readHarnessDefinitions({ layers, workspaceTrusted, env: {} }, []);
  const selection = projectHarnessSelection({ layers, workspaceTrusted }, definitions, issues);
  return { ...(selection ? { selection } : {}), issues };
}

/** Whether an Agent named `name` exists: a built-in one, or one in `harnesses` of the user settings file. */
export async function harnessDefined(cwd: string, name: string): Promise<boolean> {
  if ((BUILT_IN_HARNESSES as readonly string[]).includes(name)) return true;
  const sources = await loadSettingSources(cwd);
  const layers = sources.map(({ source, path: file, raw }: LoadedSource) => ({ source, path: file, raw }));
  return Object.hasOwn(readHarnessDefinitions({ layers, workspaceTrusted: false, env: {} }, []), name);
}

const ENVIRONMENT_NAMES = [...new Set(HARNESS_KEYS.flatMap((key) => key.env?.names ?? []))];
let processHarness: { fingerprint: string; resolved: ResolvedHarness } | undefined;

/** A copy of the variables Harness keys read, so later changes to the process environment do not apply. */
export function harnessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ENVIRONMENT_NAMES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
}

/**
 * The built-in default over the process environment and flags, without
 * settings files. Used when no runtime has installed a harness; the result is
 * reused until one of the variables it reads changes.
 */
export function resolveProcessHarness(): ResolvedHarness {
  const agentTeamsFlag = hasAgentTeamsFlag();
  const fingerprint = JSON.stringify([agentTeamsFlag, ...ENVIRONMENT_NAMES.map((name) => process.env[name] ?? null)]);
  if (processHarness?.fingerprint !== fingerprint) {
    processHarness = {
      fingerprint,
      resolved: resolveHarnessFromInputs({ layers: [], workspaceTrusted: false, env: process.env, agentTeamsFlag }),
    };
  }
  return processHarness.resolved;
}

/** The resolved value of one key. */
export function harnessValue<T = unknown>(resolved: ResolvedHarness, keyPath: string): T {
  const entry = resolved.values[keyPath];
  if (!entry) throw new Error(`unknown harness key ${keyPath}`);
  return entry.value as T;
}

/**
 * Step 25 - Configuration system
 *
 * Goal:
 * - resolve settings from ordered sources
 * - keep shareable settings separate from machine-local state
 * - protect sensitive switches from project/local files
 * - expose small /config list|get|set primitives
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Paths and source order
// -----------------------------------------------------------------------------

export const SETTING_SOURCE_ORDER = ["user", "project", "local", "flag", "policy"];
export const ARRAY_FIELDS = new Set(["allow", "deny", "ask", "additionalDirectories"]);
export const OBJECT_FIELDS = new Set(["env", "permissions", "hooks", "mcpServers", "sandbox"]);
export const SENSITIVE_FIELDS = new Set(["bypass", "autoMode", "skipPermissionPrompt", "mode"]);

let flagSettings = {};
const settingsCache = new Map();

export function getEasyAgentHome() {
  return process.env.EASY_AGENT_HOME || path.join(os.homedir(), ".easy-agent");
}

export function getUserSettingsPath() {
  return path.join(getEasyAgentHome(), "settings.json");
}

export function getProjectSettingsPath(cwd) {
  return path.join(cwd, ".easy-agent", "settings.json");
}

export function getLocalSettingsPath(cwd) {
  return path.join(cwd, ".easy-agent", "settings.local.json");
}

export function getPolicySettingsPath() {
  return process.env.EASY_AGENT_MANAGED_SETTINGS || path.join(getEasyAgentHome(), "managed-settings.json");
}

export function getStatePath() {
  return path.join(getEasyAgentHome(), "state.json");
}

export function setFlagSettings(next) {
  flagSettings = next && typeof next === "object" ? { ...next } : {};
  resetSettingsCache();
}

export function resetSettingsCache() {
  settingsCache.clear();
}

// -----------------------------------------------------------------------------
// 2. Read and validate sources
// -----------------------------------------------------------------------------

async function statSignature(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

async function readJson(filePath) {
  try {
    return { raw: JSON.parse(await fs.readFile(filePath, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { raw: null };
    return { raw: null, parseError: error.message };
  }
}

function validateSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: {}, errors: [] };

  const value = { ...raw };
  const errors = [];

  for (const key of ["allow", "deny", "ask", "additionalDirectories"]) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key])) {
      errors.push(`${key} must be an array`);
      delete value[key];
      continue;
    }
    value[key] = value[key].filter((item) => typeof item === "string" && item.trim());
  }

  if (value.env !== undefined && (!value.env || typeof value.env !== "object" || Array.isArray(value.env))) {
    errors.push("env must be an object");
    delete value.env;
  }

  if (value.model !== undefined && typeof value.model !== "string") {
    errors.push("model must be a string");
    delete value.model;
  }

  return { value, errors };
}

function buildSource(source, filePath, raw, parseError) {
  const { value, errors } = validateSettings(raw);
  return {
    source,
    path: filePath,
    raw: raw ? value : null,
    ...(parseError ? { parseError } : {}),
    ...(errors.length ? { validationErrors: errors } : {}),
  };
}

export async function loadSettingSources(cwd) {
  const files = {
    user: getUserSettingsPath(),
    project: getProjectSettingsPath(cwd),
    local: getLocalSettingsPath(cwd),
    policy: getPolicySettingsPath(),
  };

  const signatureParts = await Promise.all([
    statSignature(files.user),
    statSignature(files.project),
    statSignature(files.local),
    statSignature(files.policy),
  ]);
  const signature = [...signatureParts, JSON.stringify(flagSettings)].join("|");
  const cacheKey = path.resolve(cwd);
  const cached = settingsCache.get(cacheKey);
  if (cached?.signature === signature) return cached.sources;

  const [user, project, local, policy] = await Promise.all([
    readJson(files.user),
    readJson(files.project),
    readJson(files.local),
    readJson(files.policy),
  ]);

  const sources = [
    buildSource("user", files.user, user.raw, user.parseError),
    buildSource("project", files.project, project.raw, project.parseError),
    buildSource("local", files.local, local.raw, local.parseError),
    buildSource("flag", null, flagSettings, undefined),
    buildSource("policy", files.policy, policy.raw, policy.parseError),
  ];

  settingsCache.set(cacheKey, { signature, sources });
  return sources;
}

// -----------------------------------------------------------------------------
// 3. Merge semantics
// -----------------------------------------------------------------------------

function sourceCanReadSensitive(source) {
  return source !== "project" && source !== "local";
}

function uniqueConcat(a, b) {
  const seen = new Set(a);
  const out = [...a];
  for (const item of b) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [key, value] of Object.entries(b || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function mergeSettingSources(sources) {
  const resolved = {};
  const origins = {};

  for (const src of sources) {
    if (!src.raw) continue;
    for (const [key, value] of Object.entries(src.raw)) {
      if (SENSITIVE_FIELDS.has(key) && !sourceCanReadSensitive(src.source)) continue;

      if (ARRAY_FIELDS.has(key)) {
        resolved[key] = uniqueConcat(resolved[key] || [], Array.isArray(value) ? value : []);
      } else if (OBJECT_FIELDS.has(key)) {
        resolved[key] = deepMerge(resolved[key] || {}, value);
      } else {
        resolved[key] = value;
      }
      origins[key] = src.source;
    }
  }

  return { settings: resolved, origins };
}

export async function loadSettings(cwd) {
  return mergeSettingSources(await loadSettingSources(cwd));
}

// -----------------------------------------------------------------------------
// 4. Single-source writes and local .gitignore
// -----------------------------------------------------------------------------

function setPathValue(target, dottedKey, value) {
  const parts = dottedKey.split(".").filter(Boolean);
  let obj = target;
  for (const part of parts.slice(0, -1)) {
    obj[part] = obj[part] && typeof obj[part] === "object" ? obj[part] : {};
    obj = obj[part];
  }
  const last = parts.at(-1);
  if (!last) return;
  if (value === undefined) delete obj[last];
  else obj[last] = value;
}

async function readJsonObject(filePath) {
  const { raw } = await readJson(filePath);
  return raw && typeof raw === "object" ? raw : {};
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmpPath, filePath);
}

async function ensureLocalSettingsIgnored(cwd) {
  const gitignorePath = path.join(cwd, ".gitignore");
  const line = ".easy-agent/settings.local.json";
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch {}
  if (content.split(/\r?\n/).includes(line)) return;
  await fs.writeFile(gitignorePath, `${content}${content.endsWith("\n") || !content ? "" : "\n"}${line}\n`, "utf8");
}

export async function writeSetting(cwd, scope, key, value) {
  const filePath =
    scope === "project"
      ? getProjectSettingsPath(cwd)
      : scope === "local"
        ? getLocalSettingsPath(cwd)
        : getUserSettingsPath();

  const current = await readJsonObject(filePath);
  setPathValue(current, key, value);
  await writeJsonAtomic(filePath, current);
  if (scope === "local") await ensureLocalSettingsIgnored(cwd);
  resetSettingsCache();
}

// -----------------------------------------------------------------------------
// 5. Machine-local state and project trust
// -----------------------------------------------------------------------------

let stateCache = null;
const sessionTrusted = new Set();

function emptyState() {
  return { version: 1, prefs: {}, projects: {} };
}

function normalizeKey(filePath) {
  return path.resolve(filePath).split(path.sep).join("/");
}

export function getProjectKey(cwd) {
  return normalizeKey(cwd);
}

export async function getGlobalState() {
  if (stateCache) return stateCache;
  try {
    const raw = JSON.parse(await fs.readFile(getStatePath(), "utf8"));
    stateCache = {
      version: 1,
      prefs: raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {},
      projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
    };
  } catch {
    stateCache = emptyState();
  }
  return stateCache;
}

export async function saveGlobalState(update) {
  const draft = JSON.parse(JSON.stringify(await getGlobalState()));
  update(draft);
  await writeJsonAtomic(getStatePath(), draft);
  stateCache = draft;
}

function isAncestorOrSelf(ancestor, child) {
  return child === ancestor || child.startsWith(`${ancestor}/`);
}

function isHomeDir(projectKey) {
  return projectKey === normalizeKey(os.homedir());
}

export async function trustProject(cwd) {
  const key = getProjectKey(cwd);
  if (isHomeDir(key)) {
    sessionTrusted.add(key);
    return;
  }
  await saveGlobalState((state) => {
    state.projects[key] = { ...(state.projects[key] || {}), trusted: true };
  });
}

export async function isProjectTrusted(cwd) {
  const key = getProjectKey(cwd);
  if (sessionTrusted.has(key)) return true;
  const state = await getGlobalState();
  return Object.entries(state.projects).some(
    ([storedKey, project]) => project?.trusted && isAncestorOrSelf(storedKey, key),
  );
}

export async function loadTrustedSettingSources(cwd) {
  const sources = await loadSettingSources(cwd);
  if (await isProjectTrusted(cwd)) return sources;
  return sources.filter((source) => source.source !== "project" && source.source !== "local");
}

// -----------------------------------------------------------------------------
// 6. /config command primitives
// -----------------------------------------------------------------------------

function parseValue(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function getPathValue(obj, dottedKey) {
  return dottedKey.split(".").filter(Boolean).reduce((acc, key) => acc?.[key], obj);
}

export async function handleConfigCommand(cwd, argv) {
  const [subcommand, key, rawValue, ...flags] = argv;
  const resolved = await loadSettings(cwd);

  if (subcommand === "list") {
    return Object.entries(resolved.settings).map(([name, value]) => ({
      key: name,
      value,
      source: resolved.origins[name],
    }));
  }

  if (subcommand === "get") {
    return {
      key,
      value: getPathValue(resolved.settings, key),
      source: resolved.origins[key],
    };
  }

  if (subcommand === "set") {
    const scope = flags.includes("--project") ? "project" : flags.includes("--local") ? "local" : "user";
    await writeSetting(cwd, scope, key, parseValue(rawValue));
    return { ok: true, key, scope };
  }

  return { error: "usage: /config list|get <key>|set <key> <json|string> [--user|--project|--local]" };
}

// -----------------------------------------------------------------------------
// 7. Demo
// -----------------------------------------------------------------------------

export async function demoStep25() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step25-"));
  process.env.EASY_AGENT_HOME = path.join(cwd, "home");

  await writeSetting(cwd, "user", "model", "claude-sonnet");
  await writeSetting(cwd, "user", "allow", ["Read"]);
  await writeSetting(cwd, "project", "allow", ["Bash(ls:*)", "Read"]);
  await writeSetting(cwd, "project", "mode", "bypass");
  await writeSetting(cwd, "local", "env.NODE_ENV", "development");
  setFlagSettings({ model: "claude-opus" });

  const beforeTrust = mergeSettingSources(await loadTrustedSettingSources(cwd));
  await trustProject(cwd);
  const afterTrust = await loadSettings(cwd);
  const configList = await handleConfigCommand(cwd, ["list"]);

  return {
    beforeTrust: beforeTrust.settings,
    afterTrust: afterTrust.settings,
    modelSource: afterTrust.origins.model,
    configListKeys: configList.map((item) => item.key).sort(),
    statePath: getStatePath(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep25(), null, 2));
}

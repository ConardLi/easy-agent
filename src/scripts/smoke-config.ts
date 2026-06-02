#!/usr/bin/env tsx
/**
 * Stage 25 verification — configuration system P0, with NO LLM calls.
 *
 * Coverage:
 *   [1] Multi-source precedence — user < project < local < flag
 *   [2] Permission arrays merge (concat + dedup); `mode` security exclusion
 *       (project/local can't flip auto mode; user/flag can)
 *   [3] Fault tolerance — malformed settings.json degrades, never throws;
 *       loadSettingsDiagnostics reports it
 *   [4] Trust store — persisted under HOME (not the project), git-root key,
 *       parent-dir inheritance, atomic file
 *   [5] Trust enforcement — untrusted project hooks + statusLine are dropped,
 *       and re-appear once trusted
 *   [6] Single-source writers — updateProjectSettings / updateLocalSettings
 *       round-trip; local settings auto-added to .gitignore
 *   [7] Zod field-level validation — bad fields dropped (field-level + per-rule),
 *       unknown fields preserved, diagnostics report each repair
 *   [8] Read cache — invalidates on file change / write / flag change
 *   [9] Tier 1 config — env injection, language→prompt, apiKeyHelper (executed),
 *       cleanupPeriodDays retention/disable, additionalDirectories boundary
 *   [10] Tier 2 config — disableAllHooks (hooks+statusLine), .mcp.json approval
 *        gate, claudeMdExcludes, respectGitignore, syntaxHighlightingDisabled,
 *        prefersReducedMotion
 *
 * HOME is stubbed to a temp dir so nothing escapes into the real
 * ~/.easy-agent. Exits non-zero on any failed assertion.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  \u2713 ${msg}`);
  else {
    console.error(`  \u2717 ${msg}`);
    failures++;
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

async function main(): Promise<void> {
  // Stub HOME so getEasyAgentHome() / state.json land in a sandbox.
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  // Project dir is NOT a git repo, so the project key == its abs path.
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-proj-"));

  const paths = await import("../utils/paths.js");
  const sources = await import("../config/sources.js");
  const settings = await import("../utils/settings.js");
  const perms = await import("../permissions/permissions.js");
  const hooks = await import("../hooks/settings.js");
  const state = await import("../config/globalState.js");

  const userFile = paths.getUserSettingsPath();
  const projFile = paths.getProjectSettingsPath(proj);
  const localFile = paths.getLocalSettingsPath(proj);

  // ─── [1] precedence ────────────────────────────────────────────────────
  section("[1] Multi-source precedence (user < project < local < flag)");
  await writeJson(userFile, { outputStyle: "user-style" });
  assert((await settings.readMergedStringSetting(proj, "outputStyle")) === "user-style", "user value wins when alone");

  await writeJson(projFile, { outputStyle: "proj-style" });
  assert((await settings.readMergedStringSetting(proj, "outputStyle")) === "proj-style", "project overrides user");

  await writeJson(localFile, { outputStyle: "local-style" });
  assert((await settings.readMergedStringSetting(proj, "outputStyle")) === "local-style", "local overrides project");

  sources.setFlagSettings({ outputStyle: "flag-style" });
  assert((await settings.readMergedStringSetting(proj, "outputStyle")) === "flag-style", "flag overrides everything");
  sources.setFlagSettings(null);
  assert((await settings.readMergedStringSetting(proj, "outputStyle")) === "local-style", "clearing flag reverts to local");

  // model resolves through the same chain (the fix for --model)
  await writeJson(userFile, { outputStyle: "user-style", model: "user-model" });
  sources.setFlagSettings({ model: "flag-model" });
  assert((await settings.readMergedStringSetting(proj, "model")) === "flag-model", "--model (flag) wins for model resolution");
  sources.setFlagSettings(null);
  assert((await settings.readMergedStringSetting(proj, "model")) === "user-model", "model falls back to user settings");

  // ─── [2] permission merge + mode security exclusion ─────────────────────
  section("[2] Permission arrays merge + `mode` security exclusion");
  await writeJson(userFile, { allow: ["Read", "Bash(npm *)"], mode: "auto" });
  await writeJson(projFile, { allow: ["Read", "Edit"], mode: "auto" });
  await fs.rm(localFile, { force: true });
  let ps = await perms.loadPermissionSettings(proj);
  assert(ps.allow.includes("Bash(npm *)") && ps.allow.includes("Edit"), "allow rules concatenate across sources");
  assert(ps.allow.filter((r) => r === "Read").length === 1, "duplicate allow rule is de-duplicated");
  assert(ps.mode === "auto", "user-set mode:auto IS honored");

  await settings.updateUserSettings({ mode: undefined });
  ps = await perms.loadPermissionSettings(proj);
  assert(ps.mode === "default", "project-only mode:auto is IGNORED (security exclusion)");

  sources.setFlagSettings({ mode: "auto" });
  ps = await perms.loadPermissionSettings(proj);
  assert(ps.mode === "auto", "flag mode:auto IS honored");
  sources.setFlagSettings(null);

  // ─── [3] fault tolerance ────────────────────────────────────────────────
  section("[3] Malformed settings degrade (no crash) + diagnostics");
  await fs.writeFile(projFile, "{ this is not valid json ", "utf-8");
  let threw = false;
  try {
    ps = await perms.loadPermissionSettings(proj);
  } catch {
    threw = true;
  }
  assert(!threw, "loadPermissionSettings does NOT throw on malformed JSON");
  assert(ps.allow.includes("Bash(npm *)"), "valid user rules still apply when project file is broken");
  const diags = await settings.loadSettingsDiagnostics(proj);
  assert(diags.some((d) => d.includes(projFile)), "loadSettingsDiagnostics reports the broken file");
  // restore valid project file
  await writeJson(projFile, { allow: ["Edit"] });

  // ─── [4] trust store ─────────────────────────────────────────────────────
  section("[4] Trust store — HOME-scoped, git-root key, inheritance, atomic");
  state.resetGlobalStateCache();
  assert((await state.isProjectTrusted(proj)) === false, "fresh project is untrusted");
  await state.trustProject(proj);
  assert((await state.isProjectTrusted(proj)) === true, "project is trusted after trustProject");

  const statePath = paths.getStatePath();
  assert(fssync.existsSync(statePath), "state.json was written under HOME");
  assert(statePath.startsWith(tmpHome), "state.json lives under HOME, not the project");
  assert(!fssync.existsSync(path.join(proj, ".easy-agent", "state.json")), "trust is NOT written into the project dir");
  const stateRaw = JSON.parse(await fs.readFile(statePath, "utf-8"));
  assert(typeof stateRaw.projects === "object", "state.json is valid JSON with a projects map");

  const child = path.join(proj, "packages", "sub");
  await fs.mkdir(child, { recursive: true });
  assert((await state.isProjectTrusted(child)) === true, "subdirectory inherits trust from trusted parent");

  // a different, unrelated dir stays untrusted
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-other-"));
  assert((await state.isProjectTrusted(other)) === false, "unrelated dir is not trusted");

  // ─── [5] trust enforcement ───────────────────────────────────────────────
  section("[5] Trust enforcement — untrusted project hooks/statusLine dropped");
  const untrusted = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-untrusted-"));
  const untrustedProjFile = paths.getProjectSettingsPath(untrusted);
  await writeJson(untrustedProjFile, {
    statusLine: "echo hi",
    hooks: { Stop: [{ hooks: [{ command: "echo danger" }] }] },
  });
  state.resetGlobalStateCache();
  assert((await settings.readStatusLineConfig(untrusted)) === null, "untrusted project statusLine is NOT loaded");
  let h = await hooks.loadHooksSettings(untrusted);
  assert(!h.Stop, "untrusted project Stop hook is NOT loaded");

  await state.trustProject(untrusted);
  const sl = await settings.readStatusLineConfig(untrusted);
  assert(sl?.command === "echo hi", "trusted project statusLine IS loaded");
  h = await hooks.loadHooksSettings(untrusted);
  assert((h.Stop?.length ?? 0) === 1, "trusted project Stop hook IS loaded");

  // ─── [6] single-source writers ───────────────────────────────────────────
  section("[6] updateProjectSettings / updateLocalSettings + gitignore");
  const wproj = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-wproj-"));
  await settings.updateProjectSettings(wproj, { model: "proj-written" });
  const wprojRaw = JSON.parse(await fs.readFile(paths.getProjectSettingsPath(wproj), "utf-8"));
  assert(wprojRaw.model === "proj-written", "updateProjectSettings round-trips");

  await settings.updateLocalSettings(wproj, { model: "local-written" });
  const wlocalRaw = JSON.parse(await fs.readFile(paths.getLocalSettingsPath(wproj), "utf-8"));
  assert(wlocalRaw.model === "local-written", "updateLocalSettings round-trips");
  const gitignore = await fs.readFile(path.join(wproj, ".easy-agent", ".gitignore"), "utf-8").catch(() => "");
  assert(gitignore.split("\n").map((l) => l.trim()).includes("settings.local.json"), "local settings auto-added to .gitignore");

  // delete-key semantics
  await settings.updateProjectSettings(wproj, { model: undefined });
  const wprojRaw2 = JSON.parse(await fs.readFile(paths.getProjectSettingsPath(wproj), "utf-8"));
  assert(wprojRaw2.model === undefined, "undefined patch value deletes the key");

  // ─── [7] schema validation (P1) ──────────────────────────────────────────
  section("[7] Zod field-level validation — bad fields dropped, unknown kept");
  const vproj = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-vproj-"));
  await writeJson(userFile, { model: "fallback-model" });
  await writeJson(paths.getProjectSettingsPath(vproj), {
    model: 123, // invalid type → field dropped
    mode: "bogus", // invalid enum → field dropped
    allow: ["GoodRule", 5, "   ", "Another"], // per-rule: keep 2, drop 2
    outputStyle: "vstyle", // valid
    customKey: "keep-me", // unknown → preserved (passthrough)
  });

  assert(
    (await settings.readMergedStringSetting(vproj, "model")) === "fallback-model",
    "invalid model:123 is dropped, resolution falls back to user value",
  );
  assert(
    (await settings.readMergedStringSetting(vproj, "outputStyle")) === "vstyle",
    "valid sibling field (outputStyle) survives the bad fields",
  );

  const vps = await perms.loadPermissionSettings(vproj);
  assert(
    vps.allow.includes("GoodRule") && vps.allow.includes("Another"),
    "valid permission rules survive",
  );
  assert(
    !vps.allow.includes("5") && !vps.allow.some((r) => r.trim() === ""),
    "malformed permission rules (number / blank) are dropped per-rule",
  );

  const vsrcs = await sources.loadSettingSources(vproj);
  const vProjSrc = vsrcs.find((s) => s.source === "project");
  assert(vProjSrc?.raw?.["customKey"] === "keep-me", "unknown field is preserved (passthrough)");

  const vdiags = await settings.loadSettingsDiagnostics(vproj);
  assert(vdiags.some((d) => d.includes('ignored invalid field "model"')), "diagnostics report ignored model field");
  assert(vdiags.some((d) => d.includes('ignored invalid field "mode"')), "diagnostics report ignored mode field");
  assert(vdiags.some((d) => d.includes('invalid rule(s) in "allow"')), "diagnostics report dropped allow rules");

  // ─── [8] cache invalidation (P1) ─────────────────────────────────────────
  section("[8] Read cache — invalidates on file change / write / flag");
  const cproj = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-cproj-"));
  const cFile = paths.getProjectSettingsPath(cproj);
  await writeJson(cFile, { model: "cache-v1" });
  assert((await settings.readMergedStringSetting(cproj, "model")) === "cache-v1", "first read populates cache");

  // A direct file rewrite with a different size changes the (mtime:size)
  // signature, so the next read must NOT serve the stale cached value.
  await writeJson(cFile, { model: "cache-v2-with-a-longer-value" });
  assert(
    (await settings.readMergedStringSetting(cproj, "model")) === "cache-v2-with-a-longer-value",
    "file change invalidates the cache (mtime/size signature)",
  );

  // A write through the writer API resets the cache explicitly, so the value
  // is visible immediately even if mtime resolution were too coarse.
  await settings.updateProjectSettings(cproj, { model: "via-writer" });
  assert(
    (await settings.readMergedStringSetting(cproj, "model")) === "via-writer",
    "updateProjectSettings resets cache — write is visible on next read",
  );

  // Changing the flag layer also busts the cache.
  sources.setFlagSettings({ model: "flag-cache" });
  assert((await settings.readMergedStringSetting(cproj, "model")) === "flag-cache", "setFlagSettings busts the cache");
  sources.setFlagSettings(null);
  assert((await settings.readMergedStringSetting(cproj, "model")) === "via-writer", "clearing flag busts cache again");

  // ─── [9] Tier 1 config items ─────────────────────────────────────────────
  // [9a] env injection — trusted-source gated, later source wins per key
  section("[9a] Tier 1: env (trusted-source gated, per-key override)");
  const t1 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t1-"));
  await writeJson(userFile, { env: { USER_VAR: "u" } });
  await writeJson(paths.getProjectSettingsPath(t1), { env: { PROJ_VAR: "p", USER_VAR: "override" } });
  state.resetGlobalStateCache();
  let env = await settings.readMergedEnv(t1);
  assert(env.USER_VAR === "u" && env.PROJ_VAR === undefined, "untrusted project env dropped; user env kept");
  await state.trustProject(t1);
  env = await settings.readMergedEnv(t1);
  assert(env.PROJ_VAR === "p", "trusted project env IS injected");
  assert(env.USER_VAR === "override", "later (project) source wins per env key");

  // [9b] language → system prompt
  section("[9b] Tier 1: language → system prompt");
  await writeJson(userFile, { language: "Japanese" });
  assert((await settings.readMergedStringSetting(t1, "language")) === "Japanese", "language resolves via merged settings");
  const { buildSystemPrompt, renderSystemPrompt } = await import("../context/systemPrompt.js");
  const prompt = renderSystemPrompt(await buildSystemPrompt({ cwd: t1 }));
  assert(/Respond to the user in Japanese/.test(prompt), "language instruction appears in the system prompt");

  // [9c] apiKeyHelper — executed, trusted-source gated
  section("[9c] Tier 1: apiKeyHelper (executed, trusted-source gated)");
  const { resolveApiKeyFromHelper } = await import("../services/api/apiKeyHelper.js");
  const t2 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t2-"));
  await writeJson(paths.getProjectSettingsPath(t2), { apiKeyHelper: "echo proj-token" });
  state.resetGlobalStateCache();
  assert((await resolveApiKeyFromHelper(t2)) === null, "untrusted project apiKeyHelper does NOT run");
  await state.trustProject(t2);
  assert((await resolveApiKeyFromHelper(t2)) === "proj-token", "trusted project apiKeyHelper runs; stdout is the token");
  await writeJson(userFile, { apiKeyHelper: "echo user-token" });
  const t3 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t3-"));
  assert((await resolveApiKeyFromHelper(t3)) === "user-token", "user apiKeyHelper runs even in an untrusted dir");

  // [9d] cleanupPeriodDays — retention + disable persistence
  section("[9d] Tier 1: cleanupPeriodDays retention");
  const storage = await import("../session/storage.js");
  const t4 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t4-"));
  const sp = await storage.getSessionPaths(t4, "x");
  await fs.mkdir(sp.projectDir, { recursive: true });
  const oldFile = path.join(sp.projectDir, "old.jsonl");
  const newFile = path.join(sp.projectDir, "new.jsonl");
  await fs.writeFile(oldFile, "{}\n", "utf-8");
  await fs.writeFile(newFile, "{}\n", "utf-8");
  const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await fs.utimes(oldFile, oldTime, oldTime);
  await writeJson(paths.getProjectSettingsPath(t4), { cleanupPeriodDays: 30 });
  await storage.applySessionRetentionPolicy(t4);
  assert(storage.isSessionPersistenceEnabled() === true, "persistence enabled when period > 0");
  assert(!fssync.existsSync(oldFile), "transcript older than the period is pruned");
  assert(fssync.existsSync(newFile), "recent transcript is kept");
  await writeJson(paths.getProjectSettingsPath(t4), { cleanupPeriodDays: 0 });
  await storage.applySessionRetentionPolicy(t4);
  assert(storage.isSessionPersistenceEnabled() === false, "persistence disabled when period == 0");
  assert(!fssync.existsSync(newFile), "period 0 deletes existing transcripts");
  const init = await storage.initSessionStorage({ sessionId: "s1", cwd: t4, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), model: "m" });
  assert(!fssync.existsSync(init.transcriptPath), "with persistence off, initSessionStorage writes nothing");
  storage.configureSessionPersistence(true); // restore for any later use

  // [9e] additionalDirectories — widens the file-tool boundary
  section("[9e] Tier 1: additionalDirectories widens file boundary");
  const { setAdditionalAllowedRoots, ensureInsideAllowedRoots } = await import("../tools/pathUtils.js");
  const t5 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t5-"));
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-extra-"));
  await writeJson(paths.getProjectSettingsPath(t5), { additionalDirectories: [extra] });
  await writeJson(userFile, {}); // clear user-level keys so they don't leak in
  state.resetGlobalStateCache();
  let dirs = await settings.readTrustedStringArraySetting(t5, "additionalDirectories");
  assert(dirs.length === 0, "untrusted project additionalDirectories dropped");
  await state.trustProject(t5);
  dirs = await settings.readTrustedStringArraySetting(t5, "additionalDirectories");
  assert(dirs.includes(extra), "trusted project additionalDirectories honored");
  setAdditionalAllowedRoots(dirs);
  let boundaryThrew = false;
  try {
    ensureInsideAllowedRoots(path.join(extra, "file.txt"), t5);
  } catch {
    boundaryThrew = true;
  }
  assert(!boundaryThrew, "a path under additionalDirectories passes the boundary guard");
  boundaryThrew = false;
  try {
    ensureInsideAllowedRoots(path.join(os.tmpdir(), "ea-cfg-not-allowed-zzz", "x.txt"), t5);
  } catch {
    boundaryThrew = true;
  }
  assert(boundaryThrew, "an unrelated outside path is still blocked");
  setAdditionalAllowedRoots([]); // reset module state

  // ─── [10] Tier 2 config items ────────────────────────────────────────────
  // [10a] disableAllHooks — kills hooks AND statusLine
  section("[10a] Tier 2: disableAllHooks (hooks + statusLine)");
  const t6 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t6-"));
  await writeJson(userFile, {});
  await writeJson(paths.getProjectSettingsPath(t6), { statusLine: "echo hi", disableAllHooks: true });
  state.resetGlobalStateCache();
  await state.trustProject(t6);
  assert((await settings.isAllHooksDisabled(t6)) === true, "isAllHooksDisabled true when any source sets it");
  await hooks.refreshHookDisableFromSettings(t6);
  assert(hooks.hooksGloballyDisabled() === true, "disableAllHooks flips the master hook kill-switch");
  assert((await settings.readStatusLineConfig(t6)) === null, "disableAllHooks also suppresses the statusLine");
  await writeJson(paths.getProjectSettingsPath(t6), { statusLine: "echo hi", disableAllHooks: false });
  await hooks.refreshHookDisableFromSettings(t6);
  assert(hooks.hooksGloballyDisabled() === false, "clearing disableAllHooks re-enables hooks");
  assert((await settings.readStatusLineConfig(t6))?.command === "echo hi", "statusLine returns once disableAllHooks is off");

  // [10b] .mcp.json + approval gate
  section("[10b] Tier 2: .mcp.json approval gate");
  const mcpConfig = await import("../services/mcp/config.js");
  const t7 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t7-"));
  await writeJson(path.join(t7, ".mcp.json"), {
    mcpServers: { alpha: { command: "echo" }, beta: { command: "echo" } },
  });
  await writeJson(userFile, {});
  state.resetGlobalStateCache();
  let mcp = await mcpConfig.loadMcpConfigs(t7);
  assert(!mcp.servers.alpha && !mcp.servers.beta, "untrusted .mcp.json servers are NOT loaded");
  await state.trustProject(t7);
  mcp = await mcpConfig.loadMcpConfigs(t7);
  assert(!mcp.servers.alpha && (mcp.pending ?? []).includes("alpha") && (mcp.pending ?? []).includes("beta"), "trusted-but-unapproved .mcp.json servers are pending, not loaded");
  await writeJson(userFile, { enabledMcpjsonServers: ["alpha"] });
  mcp = await mcpConfig.loadMcpConfigs(t7);
  assert(!!mcp.servers.alpha && !mcp.servers.beta, "enabledMcpjsonServers approves only the listed server");
  await writeJson(userFile, { enableAllProjectMcpServers: true });
  mcp = await mcpConfig.loadMcpConfigs(t7);
  assert(!!mcp.servers.alpha && !!mcp.servers.beta, "enableAllProjectMcpServers approves all .mcp.json servers");
  await writeJson(userFile, { enableAllProjectMcpServers: true, disabledMcpjsonServers: ["beta"] });
  mcp = await mcpConfig.loadMcpConfigs(t7);
  assert(!!mcp.servers.alpha && !mcp.servers.beta && !(mcp.pending ?? []).includes("beta"), "disabledMcpjsonServers wins over enableAll (rejected, not pending)");

  // [10c] claudeMdExcludes
  section("[10c] Tier 2: claudeMdExcludes");
  const claudeMd = await import("../context/claudeMd.js");
  const t8 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t8-"));
  await fs.writeFile(path.join(t8, "AGENT.md"), "PROJECT-MEMORY-MARKER\n", "utf-8");
  await writeJson(userFile, {});
  let ctx = await claudeMd.loadAgentMdContext(t8);
  assert(/PROJECT-MEMORY-MARKER/.test(ctx), "AGENT.md is loaded by default");
  await writeJson(userFile, { claudeMdExcludes: ["**/AGENT.md"] });
  ctx = await claudeMd.loadAgentMdContext(t8);
  assert(!/PROJECT-MEMORY-MARKER/.test(ctx), "glob exclude (**/AGENT.md) drops the file");
  await writeJson(userFile, { claudeMdExcludes: [path.join(t8, "AGENT.md")] });
  ctx = await claudeMd.loadAgentMdContext(t8);
  assert(!/PROJECT-MEMORY-MARKER/.test(ctx), "absolute-path exclude drops the file");

  // [10d] respectGitignore — accessor + (rg-gated) functional check
  section("[10d] Tier 2: respectGitignore");
  const t9 = await fs.mkdtemp(path.join(os.tmpdir(), "ea-cfg-t9-"));
  await writeJson(userFile, { respectGitignore: false });
  assert((await settings.readMergedBooleanSetting(t9, "respectGitignore")) === false, "respectGitignore resolves false");
  await writeJson(userFile, {});
  assert((await settings.readMergedBooleanSetting(t9, "respectGitignore")) === undefined, "respectGitignore defaults to unset (treated as true)");
  const { execFile } = await import("node:child_process");
  const rgAvailable = await new Promise<boolean>((resolve) => execFile("sh", ["-lc", "command -v rg"], (e) => resolve(!e)));
  if (rgAvailable) {
    await fs.writeFile(path.join(t9, "secret.txt"), "NEEDLE-IN-IGNORED\n", "utf-8");
    await fs.writeFile(path.join(t9, ".ignore"), "secret.txt\n", "utf-8");
    const { grepTool } = await import("../tools/grepTool.js");
    const toolCtx = { cwd: t9 } as unknown as Parameters<typeof grepTool.call>[1];
    await writeJson(userFile, {}); // respect ignore (default)
    const r1 = await grepTool.call({ pattern: "NEEDLE-IN-IGNORED" }, toolCtx);
    assert(/No matches/.test(r1.content), "default respects .ignore — ignored file is skipped");
    await writeJson(userFile, { respectGitignore: false });
    const r2 = await grepTool.call({ pattern: "NEEDLE-IN-IGNORED" }, toolCtx);
    assert(/secret\.txt/.test(r2.content), "respectGitignore:false searches ignored files (--no-ignore)");
    await writeJson(userFile, {});
  } else {
    console.log("  · rg not available — skipping functional respectGitignore check");
  }

  // [10e] syntaxHighlightingDisabled
  section("[10e] Tier 2: syntaxHighlightingDisabled");
  const highlight = await import("../ui/markdown/highlight.js");
  highlight.setSyntaxHighlightingDisabled(true);
  assert(highlight.highlightCode("const x = 1;", "ts") === "const x = 1;", "disabled → raw code returned unchanged");
  highlight.setSyntaxHighlightingDisabled(false);
  assert(highlight.highlightCode("const x = 1;", "ts").includes("x"), "enabled → highlighter still returns the code");

  // [10f] prefersReducedMotion
  section("[10f] Tier 2: prefersReducedMotion");
  const motion = await import("../ui/motionPrefs.js");
  motion.setReducedMotion(true);
  assert(motion.prefersReducedMotion() === true, "reduced-motion flag set");
  motion.setReducedMotion(false);
  assert(motion.prefersReducedMotion() === false, "reduced-motion flag cleared");

  // ─── cleanup ─────────────────────────────────────────────────────────────
  for (const dir of [tmpHome, proj, other, untrusted, wproj, vproj, cproj, t1, t2, t3, t4, t5, extra, t6, t7, t8, t9]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

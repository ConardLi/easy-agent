/**
 * Real-world plugin compatibility check.
 *
 * Runs the full production pipeline — marketplace add → resolve → install →
 * enable → runtime refresh — against a REAL marketplace (a Git URL or a local
 * directory) and reports exactly which components each plugin contributed.
 *
 * This is the counterpart to test-stage35.ts: that one proves the logic against
 * synthetic fixtures, this one proves the conventions we accept actually match
 * what published marketplaces ship.
 *
 * HOME is redirected to a throwaway dir first, so nothing here touches the
 * user's real ~/.easy-agent state.
 *
 * Run: npx tsx src/scripts/verify-plugin-compat.ts <git-url|local-path>
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: npx tsx src/scripts/verify-plugin-compat.ts <git-url|local-path>\n");
  process.exit(2);
}

// ── Sandbox HOME BEFORE importing anything that resolves ~/.easy-agent. ──
const SANDBOX_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "ea-plugin-verify-"));
process.env.HOME = SANDBOX_HOME;

const marketplace = await import("../plugins/marketplace.js");
const { installPlugin } = await import("../plugins/install.js");
const runtime = await import("../plugins/runtime.js");
const { findSkill } = await import("../services/skills/registry.js");

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const OFF = "\u001b[0m";

function isGitUrl(s: string): boolean {
  return /^[a-z]+:\/\//i.test(s) || /^git@/.test(s);
}

/** Accept `owner/repo` shorthand the way published install docs write it. */
function normalizeTarget(s: string): string {
  if (isGitUrl(s) || s.startsWith(".") || s.startsWith("/")) return s;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`;
  return s;
}

async function main(): Promise<void> {
  const source = normalizeTarget(target);
  let failures = 0;

  process.stdout.write(`\n${BOLD}Source${OFF}  ${source}\n`);
  process.stdout.write(`${DIM}sandbox HOME: ${SANDBOX_HOME}${OFF}\n`);

  // ── 1. Register the marketplace (clones it when remote) ──
  process.stdout.write(`\n${BOLD}[1] marketplace add${OFF}\n`);
  const added = await marketplace.addMarketplace(
    isGitUrl(source) ? { kind: "git", url: source } : { kind: "local", path: path.resolve(source) },
  );
  process.stdout.write(`  ${GREEN}✓${OFF} registered as "${added.name}"\n`);
  process.stdout.write(`  ${DIM}manifest read from ${added.installLocation}${OFF}\n`);

  const { manifest } = await marketplace.readMarketplaceManifest(added.installLocation);
  process.stdout.write(`  ${GREEN}✓${OFF} catalog lists ${manifest.plugins.length} plugin(s)\n`);
  for (const entry of manifest.plugins) {
    const flags = [
      entry.strict === false ? "strict:false" : null,
      entry.skills !== undefined ? `skills:${JSON.stringify(entry.skills)}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(`      - ${entry.name}  ${DIM}${entry.source}  ${flags}${OFF}\n`);
  }

  // ── 2. Install every catalogued plugin ──
  process.stdout.write(`\n${BOLD}[2] install each plugin${OFF}\n`);
  const installedIds: string[] = [];
  for (const entry of manifest.plugins) {
    const id = `${entry.name}@${added.name}`;
    try {
      const result = await installPlugin(id, "user", process.cwd(), {
        // This verifier runs in an isolated temporary HOME and intentionally
        // exercises every advertised component, including Hooks/MCP.
        allowExecutableComponents: true,
      });
      installedIds.push(id);
      const l = result.loaded;
      const counts =
        `skills=${l.skills.length} agents=${l.agents.length} ` +
        `commands=${l.commands.length} styles=${l.outputStyles.length} ` +
        `hooks=${l.hooks.length} mcp=${l.mcpServers.length}`;
      const total =
        l.skills.length +
        l.agents.length +
        l.commands.length +
        l.outputStyles.length +
        l.hooks.length +
        l.mcpServers.length;
      if (total === 0) {
        failures++;
        process.stdout.write(`  ${RED}✗${OFF} ${id} installed but contributed NOTHING (${counts})\n`);
      } else {
        process.stdout.write(`  ${GREEN}✓${OFF} ${id} v${result.record.version}  ${DIM}${counts}${OFF}\n`);
      }
      for (const s of l.skills) process.stdout.write(`      skill    ${s.name}\n`);
      for (const a of l.agents) process.stdout.write(`      agent    ${a.agentType}\n`);
      for (const c of l.commands) process.stdout.write(`      command  /${c.name}\n`);
      for (const st of l.outputStyles) process.stdout.write(`      style    ${st.name}\n`);
      for (const m of l.mcpServers) process.stdout.write(`      mcp      ${m.namespacedName}\n`);
      for (const e of l.errors) {
        failures++;
        process.stdout.write(`      ${RED}error [${e.scope}] ${e.message}${OFF}\n`);
      }
      for (const w of l.warnings.slice(0, 3)) {
        process.stdout.write(`      ${YELLOW}warn  ${w}${OFF}\n`);
      }
    } catch (error) {
      failures++;
      process.stdout.write(`  ${RED}✗${OFF} ${id} install FAILED: ${(error as Error).message}\n`);
    }
  }

  // ── 3. Reload from disk only, as a fresh process would ──
  process.stdout.write(`\n${BOLD}[3] runtime refresh (simulates a restart)${OFF}\n`);
  runtime._resetPluginRuntimeForTesting();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ea-plugin-verify-proj-"));
  const res = await runtime.refreshActivePlugins(cwd, { applyMcp: false });
  process.stdout.write(`  ${GREEN}✓${OFF} ${res.plugins.length} plugin(s) active after reload\n`);

  // Every skill seen at install time must still resolve from the registry —
  // this is what catches load options that weren't persisted.
  let resolvedSkills = 0;
  for (const p of res.plugins) {
    for (const s of p.skills) {
      if (findSkill(s.name)) {
        resolvedSkills++;
      } else {
        failures++;
        process.stdout.write(`  ${RED}✗${OFF} skill ${s.name} missing from registry after reload\n`);
      }
    }
  }
  process.stdout.write(`  ${GREEN}✓${OFF} ${resolvedSkills} plugin skill(s) resolvable by namespaced name\n`);

  if (installedIds.length > 0 && res.plugins.length !== installedIds.length) {
    failures++;
    process.stdout.write(
      `  ${RED}✗${OFF} expected ${installedIds.length} active plugin(s), got ${res.plugins.length}\n`,
    );
  }
  for (const e of res.errors) {
    failures++;
    process.stdout.write(`  ${RED}✗ [${e.pluginId}/${e.scope}] ${e.message}${OFF}\n`);
  }

  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  await fs.rm(SANDBOX_HOME, { recursive: true, force: true }).catch(() => {});

  const verdict = failures === 0 ? `${GREEN}COMPATIBLE${OFF}` : `${RED}${failures} problem(s)${OFF}`;
  process.stdout.write(`\n${BOLD}Result: ${verdict}${OFF}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  process.stderr.write(`\n${RED}fatal: ${(error as Error).message}${OFF}\n`);
  await fs.rm(SANDBOX_HOME, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});

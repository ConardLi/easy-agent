/**
 * Project memory file names: `AGENTS.md` and `AGENT.md`.
 *
 * Covers the three layouts (only AGENT.md, only AGENTS.md, both), load order
 * across the directory chain, `claudeMdExcludes` for each name, the `/memory`
 * target list, and the sandbox write deny for the project files.
 *
 * Run: node --import tsx src/scripts/test-project-memory-files.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-memory-files-")));
const home = path.join(root, "home");
await mkdir(path.join(home, ".easy-agent"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.EASY_AGENT_DISABLE_HOOKS = "1";

const { loadAgentMdContext } = await import("../context/claudeMd.js");
const { collectMemoryTargets } = await import("../core/queryEngine/commands/memory.js");
const { buildSandboxProfile, DEFAULT_RESOLVED_SANDBOX_SETTINGS } = await import("../sandbox/index.js");

const USER_SETTINGS = path.join(home, ".easy-agent", "settings.json");
const GLOBAL_AGENT_MD = path.join(home, ".easy-agent", "AGENT.md");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
async function project(files: Record<string, string>): Promise<string> {
  const dir = path.join(root, `p${++seq}`);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content, "utf-8");
  }
  return dir;
}

const section = (filePath: string, content: string): string => `# Source: ${filePath}\n${content}`;

async function targetsOf(cwd: string): Promise<Array<{ label: string; path: string; exists: boolean }>> {
  return (await collectMemoryTargets(cwd)).map(({ label, path: p, exists }) => ({ label, path: p, exists }));
}

try {
  await writeFile(USER_SETTINGS, "{}\n", "utf-8");
  await writeFile(GLOBAL_AGENT_MD, "GLOBAL\n", "utf-8");

  await check("only AGENT.md: global, then each directory from the outermost, same as before", async () => {
    const dir = await project({ "AGENT.md": "ROOT\n", "sub/AGENT.md": "SUB\n" });
    const ctx = await loadAgentMdContext(path.join(dir, "sub"));
    assert.equal(
      ctx,
      [
        section(GLOBAL_AGENT_MD, "GLOBAL"),
        section(path.join(dir, "AGENT.md"), "ROOT"),
        section(path.join(dir, "sub", "AGENT.md"), "SUB"),
      ].join("\n\n"),
    );
  });

  await check("only AGENTS.md: the file is loaded", async () => {
    const dir = await project({ "AGENTS.md": "SHARED\n" });
    const ctx = await loadAgentMdContext(dir);
    assert.equal(
      ctx,
      [section(GLOBAL_AGENT_MD, "GLOBAL"), section(path.join(dir, "AGENTS.md"), "SHARED")].join("\n\n"),
    );
  });

  await check("both: AGENTS.md before AGENT.md in each directory, outer directories first", async () => {
    const dir = await project({
      "AGENTS.md": "ROOT-SHARED\n",
      "AGENT.md": "ROOT-OWN\n",
      "sub/AGENTS.md": "SUB-SHARED\n",
      "sub/AGENT.md": "SUB-OWN\n",
    });
    const ctx = await loadAgentMdContext(path.join(dir, "sub"));
    assert.equal(
      ctx,
      [
        section(GLOBAL_AGENT_MD, "GLOBAL"),
        section(path.join(dir, "AGENTS.md"), "ROOT-SHARED"),
        section(path.join(dir, "AGENT.md"), "ROOT-OWN"),
        section(path.join(dir, "sub", "AGENTS.md"), "SUB-SHARED"),
        section(path.join(dir, "sub", "AGENT.md"), "SUB-OWN"),
      ].join("\n\n"),
    );
  });

  await check("global memory stays ~/.easy-agent/AGENT.md only", async () => {
    await writeFile(path.join(home, ".easy-agent", "AGENTS.md"), "GLOBAL-SHARED\n", "utf-8");
    const dir = await project({});
    const ctx = await loadAgentMdContext(dir);
    await rm(path.join(home, ".easy-agent", "AGENTS.md"));
    assert.equal(ctx, section(GLOBAL_AGENT_MD, "GLOBAL"));
  });

  await check("claudeMdExcludes: each name is matched by its own pattern", async () => {
    const dir = await project({ "AGENTS.md": "SHARED\n", "AGENT.md": "OWN\n" });
    await writeFile(USER_SETTINGS, JSON.stringify({ claudeMdExcludes: ["**/AGENTS.md"] }), "utf-8");
    let ctx = await loadAgentMdContext(dir);
    assert.ok(!ctx.includes("SHARED") && ctx.includes("OWN"), "**/AGENTS.md drops only AGENTS.md");
    await writeFile(USER_SETTINGS, JSON.stringify({ claudeMdExcludes: ["**/AGENT.md"] }), "utf-8");
    ctx = await loadAgentMdContext(dir);
    assert.ok(
      ctx.includes("SHARED") && !ctx.includes("OWN") && !ctx.includes("GLOBAL"),
      "**/AGENT.md drops AGENT.md files only",
    );
    await writeFile(USER_SETTINGS, JSON.stringify({ claudeMdExcludes: [path.join(dir, "AGENTS.md")] }), "utf-8");
    ctx = await loadAgentMdContext(dir);
    assert.ok(!ctx.includes("SHARED") && ctx.includes("OWN"), "absolute path drops that AGENTS.md");
    await writeFile(USER_SETTINGS, "{}\n", "utf-8");
  });

  await check("/memory: a project without memory files offers the project AGENT.md, as before", async () => {
    const dir = await project({});
    assert.deepEqual(await targetsOf(dir), [
      { label: "global AGENT.md", path: GLOBAL_AGENT_MD, exists: true },
      { label: "project AGENT.md", path: path.join(dir, "AGENT.md"), exists: false },
    ]);
  });

  await check("/memory: only AGENTS.md lists it and offers no empty AGENT.md", async () => {
    const dir = await project({ "AGENTS.md": "SHARED\n" });
    assert.deepEqual(await targetsOf(dir), [
      { label: "global AGENT.md", path: GLOBAL_AGENT_MD, exists: true },
      { label: "project AGENTS.md", path: path.join(dir, "AGENTS.md"), exists: true },
    ]);
  });

  await check("/memory: both files and an ancestor AGENTS.md are listed in load order", async () => {
    const dir = await project({ "AGENTS.md": "ROOT\n", "sub/AGENTS.md": "S\n", "sub/AGENT.md": "O\n" });
    assert.deepEqual(await targetsOf(path.join(dir, "sub")), [
      { label: "global AGENT.md", path: GLOBAL_AGENT_MD, exists: true },
      { label: "AGENTS.md", path: path.join(dir, "AGENTS.md"), exists: true },
      { label: "project AGENTS.md", path: path.join(dir, "sub", "AGENTS.md"), exists: true },
      { label: "project AGENT.md", path: path.join(dir, "sub", "AGENT.md"), exists: true },
    ]);
  });

  await check("sandbox: sandboxed commands cannot rewrite the project AGENTS.md or AGENT.md", async () => {
    const dir = await project({});
    const profile = buildSandboxProfile({
      cwd: dir,
      settings: { ...DEFAULT_RESOLVED_SANDBOX_SETTINGS, enabled: true },
      permissions: { allow: [], deny: [] },
    });
    assert.ok(profile.filesystem.denyWrite.includes(path.join(dir, "AGENTS.md")));
    assert.ok(profile.filesystem.denyWrite.includes(path.join(dir, "AGENT.md")));
  });

  console.log(`\nproject memory files: ${passed} passed`);
} finally {
  await rm(root, { recursive: true, force: true });
}

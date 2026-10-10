import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  checkPath,
  installSkill,
  parseSkillFrontmatter,
  previewSkill,
  setMcpJsonServer,
  skillFolderToRemove,
  writeText,
} from "../../src/main/services/customize";
import { addHook, contextGroups, fixedCost, type HooksBlock, removeHook } from "../../src/renderer/features/customize/model";
import { listSlash } from "../../src/renderer/lib/slash";
import type { RuntimeInventory, SessionContext } from "../../src/shared/agent";

/** A home with `~/.easy-agent`, a parent folder, and a workspace inside it. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "easy-agent-customize-")));
  const home = join(root, "home");
  const parent = join(root, "code");
  const workspace = join(parent, "demo");
  mkdirSync(join(home, ".easy-agent"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  process.env.HOME = home;
  return { root, home, parent, workspace };
}

test("paths outside the workspace and ~/.easy-agent are refused, except parent rule files", async () => {
  const { root, home, parent, workspace } = world();
  writeFileSync(join(root, "secret.txt"), "x");
  writeFileSync(join(parent, "AGENTS.md"), "# parent");
  symlinkSync(join(root, "secret.txt"), join(workspace, "link.md"));

  expect(await checkPath(workspace, join(workspace, "AGENTS.md"))).toBe(join(workspace, "AGENTS.md"));
  expect(await checkPath(workspace, "~/.easy-agent/AGENT.md")).toBe(join(home, ".easy-agent", "AGENT.md"));
  expect(await checkPath(workspace, join(parent, "AGENTS.md"))).toBe(join(parent, "AGENTS.md"));
  await expect(checkPath(workspace, join(root, "secret.txt"))).rejects.toThrow("不能访问");
  await expect(checkPath(workspace, join(parent, "notes.md"))).rejects.toThrow("不能访问");
  await expect(checkPath(workspace, join(workspace, "link.md"))).rejects.toThrow("不能访问");
  await expect(checkPath(workspace, "relative/AGENTS.md")).rejects.toThrow("绝对路径");
  await expect(checkPath(workspace, join(workspace, ".easy-agent", "settings.json"), { write: true })).rejects.toThrow("Markdown");

  await writeText(workspace, join(workspace, "docs", "AGENT.md"), "# rules\n");
  expect(readFileSync(join(workspace, "docs", "AGENT.md"), "utf8")).toBe("# rules\n");
});

test("a skill folder is previewed, installed once, and only skills folders can be removed", async () => {
  const { root, home, workspace } = world();
  const source = join(root, "downloads", "pdf-tools");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, ".git"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), '---\nname: "pdf"\ndescription: Read and merge PDF files\n---\n\nUse the scripts.\n');
  writeFileSync(join(source, "scripts", "merge.py"), "print(1)\n");
  writeFileSync(join(source, ".git", "HEAD"), "ref");

  expect(parseSkillFrontmatter("---\nname: a\ndescription: 'b c'\n---")).toEqual({ name: "a", description: "b c" });
  const preview = await previewSkill(source);
  expect(preview).toEqual({ source, name: "pdf", description: "Read and merge PDF files", files: ["SKILL.md", "scripts/merge.py"] });
  await expect(previewSkill(join(root, "downloads"))).rejects.toThrow("SKILL.md");

  const dest = await installSkill(workspace, source, "project");
  expect(dest).toBe(join(workspace, ".easy-agent", "skills", "pdf"));
  expect(readFileSync(join(dest, "scripts", "merge.py"), "utf8")).toBe("print(1)\n");
  await expect(installSkill(workspace, source, "project")).rejects.toThrow("已经有");
  expect(await installSkill(workspace, join(source, "SKILL.md"), "user")).toBe(join(home, ".easy-agent", "skills", "pdf"));

  expect(await skillFolderToRemove(workspace, dest)).toBe(dest);
  await expect(skillFolderToRemove(workspace, source)).rejects.toThrow("只能删除");
  await expect(skillFolderToRemove(workspace, workspace)).rejects.toThrow("只能删除");
});

test("one .mcp.json server is added and removed, the rest of the file stays", async () => {
  const { workspace } = world();
  writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "a" } }, other: 1 }));
  await setMcpJsonServer(workspace, "echo", { command: "node", args: ["echo.mjs"] });
  expect(JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8"))).toEqual({
    mcpServers: { keep: { command: "a" }, echo: { command: "node", args: ["echo.mjs"] } },
    other: 1,
  });
  await setMcpJsonServer(workspace, "echo", null);
  expect(JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8")).mcpServers).toEqual({ keep: { command: "a" } });
  await expect(setMcpJsonServer(workspace, "bad name", null)).rejects.toThrow("服务器名");
});

test("hooks are added and removed by the position the Agent counts them in", () => {
  const block: HooksBlock = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "first" }, { type: "prompt", command: "skipped" } as never, { command: "second" }] },
      { hooks: [{ command: "third" }] },
    ],
  };
  expect(removeHook(block, "PreToolUse", 1)).toEqual({
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "first" },
          { type: "prompt", command: "skipped" },
        ],
      },
      { hooks: [{ command: "third" }] },
    ],
  });
  expect(removeHook(removeHook(block, "PreToolUse", 2), "PreToolUse", 1).PreToolUse).toHaveLength(1);
  expect(removeHook({ Stop: [{ hooks: [{ command: "x" }] }] }, "Stop", 0)).toEqual({});
  expect(addHook({}, { event: "PostToolUse", matcher: "Edit", command: "fmt", timeout: 60 })).toEqual({
    PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }],
  });
  expect(addHook({}, { event: "Stop", command: "check", timeout: 30, shell: "sh" }).Stop?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: "check",
    timeout: 30,
    shell: "sh",
  });
});

const tokens = (value: number) => ({ value, estimated: true });
const base = { enabled: true, path: "/x" };
const inventory = {
  workspaceTrusted: true,
  ignoredProjectConfig: [],
  skills: [
    {
      ...base,
      kind: "skill",
      id: "skill:project:review",
      name: "review",
      source: "project",
      description: "Review",
      invocation: "model",
      allowedTools: [],
      fork: false,
      listing: tokens(30),
      body: tokens(400),
    },
    {
      ...base,
      kind: "skill",
      id: "skill:plugin:kit:notes",
      name: "kit:notes",
      source: "plugin",
      pluginId: "kit@acme",
      description: "Notes",
      argumentHint: "<topic>",
      invocation: "model",
      allowedTools: [],
      fork: false,
      listing: tokens(20),
      body: tokens(100),
    },
  ],
  commands: [
    { ...base, kind: "command", id: "command:built-in:help", name: "help", source: "built-in", description: "Help" },
    { ...base, kind: "command", id: "command:user:ship", name: "ship", source: "user", description: "Ship it" },
  ],
  agents: [{ ...base, kind: "agent", id: "agent:plugin:a", name: "a", source: "plugin", pluginId: "kit@acme", description: "A", listing: tokens(15) }],
  outputStyles: [],
  mcpServers: [
    {
      ...base,
      kind: "mcp_server",
      id: "mcp_server:gh",
      name: "gh",
      source: "user",
      transport: "stdio",
      status: "connected",
      tools: [
        { name: "a", description: "", readOnly: true, deferred: false, schema: tokens(100) },
        { name: "b", description: "", readOnly: true, deferred: true, schema: tokens(300) },
      ],
    },
  ],
  plugins: [{ ...base, kind: "plugin", id: "plugin:kit@acme", name: "kit", source: "user", pluginId: "kit@acme" }],
  hooks: [],
  rules: [
    { ...base, kind: "rule", id: "rule:a", name: "AGENTS.md", source: "project", scope: "project", excluded: false, lines: 3, tokens: tokens(50) },
    {
      ...base,
      kind: "rule",
      id: "rule:b",
      name: "AGENTS.md",
      source: "project",
      scope: "ancestor",
      excluded: true,
      enabled: false,
      lines: 3,
      tokens: tokens(70),
    },
  ],
  tools: [
    { ...base, kind: "tool", id: "tool:Read", name: "Read", source: "built-in", description: "", readOnly: true, deferred: false, schema: tokens(200) },
    { ...base, kind: "tool", id: "tool:WebFetch", name: "WebFetch", source: "built-in", description: "", readOnly: true, deferred: true, schema: tokens(90) },
    {
      ...base,
      kind: "tool",
      id: "tool:PowerShell",
      name: "PowerShell",
      source: "built-in",
      enabled: false,
      description: "",
      readOnly: false,
      deferred: false,
      schema: tokens(80),
    },
    {
      ...base,
      kind: "tool",
      id: "tool:mcp__gh__a",
      name: "mcp__gh__a",
      source: "user",
      mcpServer: "gh",
      description: "",
      readOnly: true,
      deferred: false,
      schema: tokens(100),
    },
  ],
} as unknown as RuntimeInventory;

test("the per-turn cost counts what every request carries, plugin parts under the plugin", () => {
  expect(fixedCost(inventory)).toEqual({ skills: 30, tools: 200, mcp: 100, plugins: 35, rules: 50 });
});

test("slash entries carry their source and argument hint from the inventory", () => {
  const entries = listSlash(undefined, inventory);
  expect(entries.find((e) => e.name === "review")).toMatchObject({ group: "skill", source: "项目" });
  expect(entries.find((e) => e.name === "kit:notes")).toMatchObject({ source: "插件 kit", args: "<topic>" });
  expect(entries.find((e) => e.name === "ship")).toMatchObject({ group: "command", source: "全局" });
  expect(entries.some((e) => e.name === "help")).toBe(false);
});

test("context groups get labels, colors, and readable item names", () => {
  const context = {
    model: "m",
    contextWindow: 1000,
    estimated: true,
    used: 60,
    free: 940,
    conversationTokens: 10,
    autoCompactThreshold: 900,
    totals: { systemPrompt: 20, memory: 20, tools: 10, conversation: 10 },
    toolSearch: { enabled: false, deferred: [], loaded: [], sentTools: 1, alwaysLoadedTokens: 10, loadedTokens: 0 },
    categories: [
      { id: "system", tokens: 20, items: [{ id: "instructions", label: "Instructions", tokens: 20, source: "built-in" }] },
      { id: "tools", tokens: 10, items: [{ id: "Read", label: "Read", tokens: 10, source: "built-in" }] },
      { id: "mcp", tokens: 0, items: [] },
      { id: "skills", tokens: 0, items: [] },
      { id: "plugins", tokens: 0, items: [] },
      { id: "rules", tokens: 20, items: [{ id: "/w/AGENTS.md", label: "/w/AGENTS.md", tokens: 20, source: "project" }] },
      { id: "messages", tokens: 10, items: [{ id: "user", label: "User messages", tokens: 10 }] },
    ],
  } as SessionContext;
  const groups = contextGroups(context, "/w");
  expect(groups.map((g) => g.label)).toEqual(["系统提示词", "内置工具", "MCP", "技能", "插件", "规则", "对话消息"]);
  expect(groups[0]?.items[0]).toEqual({ id: "instructions", label: "基础指令", tokens: 20 });
  expect(groups[1]?.items[0]?.source).toBe("内置");
  expect(groups[5]?.items[0]?.label).toBe("AGENTS.md");
  expect(groups[6]?.items[0]?.label).toBe("你的消息");
  expect(groups[1]?.tab).toBe("tools");
});

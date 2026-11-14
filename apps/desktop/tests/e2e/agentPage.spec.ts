import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import type { RecordedRequest } from "../../../../src/scripts/fixtures/anthropicFixture";
import { type AgentWorld, createAgentWorld, openProject, send } from "../helpers/agent";
import { launchApp } from "../helpers/app";

let world: AgentWorld;

const userSettings = () => join(world.home, ".easy-agent", "settings.json");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const harnesses = () => (readJson(userSettings()).harnesses ?? {}) as Record<string, Record<string, unknown>>;

function writeAgents(agents: Record<string, unknown>): void {
  writeFileSync(userSettings(), JSON.stringify({ harnesses: agents }));
}

function trustProject(): void {
  writeFileSync(join(world.home, ".easy-agent", "state.json"), JSON.stringify({ version: 1, prefs: {}, projects: { [world.project]: { trusted: true } } }));
}

function requestFor(prompt: string): RecordedRequest {
  const found = world.fixture.requests.filter((request) => JSON.stringify(request.messages).includes(prompt)).at(-1);
  if (!found) throw new Error(`no request carried ${prompt}`);
  return found;
}

const toolNames = (request: RecordedRequest) => ((request.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
const systemText = (request: RecordedRequest) => JSON.stringify(request.system ?? "");

async function openAgentPage(page: Page, name?: string): Promise<void> {
  await page
    .locator("aside")
    .getByRole("button", { name: /^Agent/ })
    .click();
  await expect(page.locator("[data-harness]")).toBeVisible({ timeout: 20_000 });
  if (name) await selectAgent(page, name);
}

async function selectAgent(page: Page, name: string): Promise<void> {
  await page.locator(`[data-agent="${name}"]`).click();
  await expect(page.locator(`[data-harness="${name}"]`)).toBeVisible({ timeout: 20_000 });
}

const tab = (page: Page, label: string) => page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
const rowSwitch = (page: Page, row: string) => page.locator(`[data-row="${row}"]`).getByRole("switch");

/** The Agent of each open session, by the process that has it open. */
async function openAgents(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { activeId } = await window.easyAgent.workspaces.get();
    return (await window.easyAgent.agent.openSessions(activeId ?? "")).map((s) => s.agent).sort();
  });
}

async function answerSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
}

async function answerOpenDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, path);
}

test.beforeEach(async () => {
  world = await createAgentWorld();
});

test.afterEach(async () => {
  await world.fixture.close();
});

test("copy default, turn a tool off, replace the identity, and a session with the copy sends exactly that", async () => {
  world.fixture.script([
    { kind: "text", text: "精简 Agent 的第一次回答。" },
    { kind: "text", text: "精简 Agent 的第二次回答。" },
    { kind: "text", text: "默认 Agent 的回答。" },
  ]);
  const { app, page } = await openProject(world);
  try {
    await openAgentPage(page);
    await expect(page.locator('[data-agent="default"]')).toBeVisible();
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "复制" }).click();
    await page.getByRole("textbox", { name: "Agent 名字" }).fill("lean");
    await page.getByRole("button", { name: "复制", exact: true }).click();
    await expect(page.locator('[data-harness="lean"]')).toBeVisible({ timeout: 20_000 });
    expect(harnesses().lean).toEqual({});

    await tab(page, "工具");
    await rowSwitch(page, "tools:Bash").click();
    await expect(rowSwitch(page, "tools:Bash")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    await expect(page.locator('[data-row="tools:Bash"]').getByText("这个 Agent 的 tools.exclude 去掉了它")).toBeVisible();
    expect(harnesses().lean).toEqual({ tools: { exclude: ["Bash"] } });

    await tab(page, "提示词");
    await page.locator('[data-row="prompt.identity"]').getByRole("button", { name: "编辑" }).click();
    await expect(page.getByRole("textbox", { name: "提示词内容" })).toHaveValue(/^You are Easy Agent/);
    await page.getByRole("textbox", { name: "提示词内容" }).fill("You are the lean Agent. Answer in one line.");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.locator('[data-row="prompt.identity"]').getByText("You are the lean Agent. Answer in one line.")).toBeVisible({ timeout: 20_000 });
    expect(harnesses().lean).toEqual({ tools: { exclude: ["Bash"] }, prompt: { identity: { file: "prompts/lean.identity.md" } } });
    expect(readFileSync(join(world.home, ".easy-agent", "prompts", "lean.identity.md"), "utf8")).toBe("You are the lean Agent. Answer in one line.");
    expect(harnesses().default, "copying and editing leaves default as it was").toBeUndefined();

    await page.getByRole("button", { name: "用它新建会话" }).click();
    await expect(page.getByRole("button", { name: "Agent：lean" })).toBeVisible();
    await send(page, "用精简 Agent");
    await expect(page.getByText("精简 Agent 的第一次回答。")).toBeVisible({ timeout: 30_000 });
    const lean = requestFor("用精简 Agent");
    expect(toolNames(lean)).not.toContain("Bash");
    expect(toolNames(lean)).toContain("Read");
    expect(systemText(lean)).toContain("You are the lean Agent. Answer in one line.");
    expect(systemText(lean)).not.toContain("You are Easy Agent, a terminal-native");
    expect(await openAgents(page)).toEqual(["lean"]);

    // A change to the Agent its process runs applies from the session's next request, without a restart.
    await openAgentPage(page, "lean");
    await tab(page, "工具");
    await rowSwitch(page, "tools:Read").click();
    await expect(rowSwitch(page, "tools:Read")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    await page.getByRole("button", { name: "返回对话" }).click();
    await send(page, "再来一次");
    await expect(page.getByText("精简 Agent 的第二次回答。")).toBeVisible({ timeout: 30_000 });
    expect(toolNames(requestFor("再来一次"))).not.toContain("Read");

    await page.getByRole("button", { name: "新建会话" }).click();
    await send(page, "用默认 Agent");
    await expect(page.getByText("默认 Agent 的回答。")).toBeVisible({ timeout: 30_000 });
    const plain = requestFor("用默认 Agent");
    expect(toolNames(plain)).toContain("Bash");
    expect(toolNames(plain)).toContain("Read");
    expect(systemText(plain)).toContain("You are Easy Agent, a terminal-native");
  } finally {
    await app.close();
  }
});

test("Agents are created, renamed, set as the workspace default, exported, imported, and default is restored", async () => {
  trustProject();
  writeAgents({ base: { description: "基础 Agent" }, child: { extends: "base", description: "子 Agent" } });
  world.fixture.script([{ kind: "text", text: "项目默认 Agent 的回答。" }]);
  const { app, page } = await openProject(world);
  try {
    await openAgentPage(page, "child");
    await expect(page.locator('[data-harness="child"]').getByText("继承链")).toBeVisible();

    // The workspace default moves to child; new sessions use it, the running default process keeps its Agent.
    await page.getByRole("button", { name: "设为项目默认" }).click();
    await expect(page.locator('[data-harness="child"] h2').getByText("项目默认", { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(readJson(join(world.project, ".easy-agent", "settings.local.json")).harness).toBe("child");
    await page.getByRole("button", { name: "用它新建会话" }).click();
    await expect(page.getByRole("button", { name: "Agent：child" })).toBeVisible();
    await send(page, "用项目默认");
    await expect(page.getByText("项目默认 Agent 的回答。")).toBeVisible({ timeout: 30_000 });
    expect(await openAgents(page)).toEqual(["child"]);

    // Renaming base rewrites child's extends; deleting it while child extends it is refused.
    await openAgentPage(page, "base");
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "改名" }).click();
    await page.getByRole("textbox", { name: "新名字" }).fill("core");
    await page.getByRole("button", { name: "改名", exact: true }).click();
    await expect(page.locator('[data-harness="core"]')).toBeVisible({ timeout: 20_000 });
    expect(harnesses().child?.extends).toBe("core");
    expect(harnesses().base).toBeUndefined();
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(page.getByText("child 继承了它，先改掉它们的 extends 再删。")).toBeVisible();
    await expect(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "取消" }).click();

    // A new Agent over core.
    await page.getByRole("button", { name: "新建 Agent" }).click();
    await page.getByRole("textbox", { name: "Agent 名字" }).fill("Bad Name");
    await expect(page.getByText("只能用字母、数字、点、下划线和短横线，以字母或数字开头")).toBeVisible();
    await page.getByRole("textbox", { name: "Agent 名字" }).fill("writer");
    await page.getByRole("combobox").selectOption("core");
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.locator('[data-harness="writer"]')).toBeVisible({ timeout: 20_000 });
    expect(harnesses().writer).toEqual({ extends: "core" });

    // Export child, then import the file under another name after the preview.
    const exported = join(world.home, "child.agent.json");
    await answerSaveDialog(app, exported);
    await selectAgent(page, "child");
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "导出" }).click();
    await expect.poll(() => existsSync(exported), { timeout: 20_000 }).toBe(true);
    expect(readJson(exported)).toMatchObject({ format: "easy-agent-harness", version: 1, name: "child" });
    await answerOpenDialog(app, exported);
    await page.getByRole("button", { name: "导入 Agent" }).click();
    await expect(page.getByText("导入 child", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("保留的内置工具")).toBeVisible();
    await expect(page.getByRole("button", { name: "替换" })).toBeVisible();
    await page.getByRole("dialog").getByRole("textbox").fill("child-copy");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.locator('[data-harness="child-copy"]')).toBeVisible({ timeout: 20_000 });
    expect(harnesses()["child-copy"]).toBeDefined();

    // Editing default stores only the change; restoring it removes the entry.
    await selectAgent(page, "default");
    await tab(page, "上下文");
    await rowSwitch(page, "context.gitStatus").click();
    await expect(rowSwitch(page, "context.gitStatus")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    expect(harnesses().default).toEqual({ context: { gitStatus: false } });
    await expect(page.locator('[data-agent="default"]').getByText("改过")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: "恢复默认" }).click();
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    await expect(page.locator('[data-agent="default"]').getByText("改过")).toHaveCount(0, { timeout: 20_000 });
    expect(harnesses().default).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("settings a layer above the Agent decides are locked and name the file or variable", async () => {
  trustProject();
  writeAgents({ capped: { features: { maxTurns: 40 } } });
  mkdirSync(join(world.project, ".easy-agent"), { recursive: true });
  writeFileSync(join(world.project, ".easy-agent", "settings.json"), JSON.stringify({ maxTurns: 80 }));
  const launched = await launchApp({ prefs: { theme: "dark" }, env: { ...world.env, EASY_AGENT_MAX_RETRIES: "3" } });
  const { app, page } = launched;
  try {
    const { answerFolderDialog } = await import("../helpers/app");
    await answerFolderDialog(app, world.project);
    await page.getByRole("button", { name: /^打开文件夹/ }).click();
    await openAgentPage(page, "capped");
    await tab(page, "功能");
    const turns = page.locator('[data-row="features.maxTurns"]');
    await expect(turns.getByText("被项目设置覆盖：.easy-agent/settings.json 的 maxTurns")).toBeVisible();
    await expect(turns.locator("[aria-disabled]")).toBeVisible();
    await expect(page.locator('[data-row="features.maxRetries"]').getByText("被环境变量覆盖：EASY_AGENT_MAX_RETRIES")).toBeVisible();
    // A value only the Agent sets is its own and stays editable.
    await expect(page.locator('[data-row="features.tasks"] [data-source="built-in"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the customize and settings switches that were waiting for Agent settings write the workspace's Agent", async () => {
  world.fixture.script([{ kind: "text", text: "关掉 Glob 以后。" }]);
  const { app, page } = await openProject(world);
  try {
    await page
      .locator("aside")
      .getByRole("button", { name: /^自定义/ })
      .click();
    await page.getByRole("button", { name: /^工具/ }).first().click();
    const glob = page.locator('[data-agent-switch="tools:Glob"]').getByRole("switch");
    await expect(glob).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
    await glob.click();
    await expect(glob).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    expect(harnesses().default).toEqual({ tools: { exclude: ["Glob"] } });

    await page.getByRole("button", { name: "返回对话" }).click();
    await send(page, "没有 Glob");
    await expect(page.getByText("关掉 Glob 以后。")).toBeVisible({ timeout: 30_000 });
    expect(toolNames(requestFor("没有 Glob"))).not.toContain("Glob");

    await page.getByRole("button", { name: "设置" }).click();
    await page.getByRole("button", { name: "行为", exact: true }).click();
    const caching = page.locator('[data-row="features.promptCaching"]').getByRole("switch");
    await expect(caching).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
    await caching.click();
    await expect(caching).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    expect(harnesses().default).toEqual({ tools: { exclude: ["Glob"] }, features: { promptCaching: false } });
    // Only the settings no Agent key covers yet keep their TODO mark: the MCP timeout and the web search backend.
    await expect(page.getByText("TODO", { exact: true })).toHaveCount(3);
  } finally {
    await app.close();
  }
});

/** A stdio MCP server with one read-only `echo` tool. */
function writeEchoServer(): string {
  const path = join(world.home, "echo-server.mjs");
  const module = (specifier: string) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`));
  writeFileSync(
    path,
    `
import { Server } from ${module("server/index.js")};
import { StdioServerTransport } from ${module("server/stdio.js")};
import { ListToolsRequestSchema } from ${module("types.js")};
const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
}));
await server.connect(new StdioServerTransport());
`,
  );
  return path;
}

test("turning an MCP server off marks the processes that started it, and restarting them drops its tools", async () => {
  writeFileSync(userSettings(), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [writeEchoServer()] } } }));
  world.fixture.script([
    { kind: "text", text: "有 echo。" },
    { kind: "text", text: "没有 echo。" },
  ]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "第一次");
    await expect(page.getByText("有 echo。")).toBeVisible({ timeout: 30_000 });
    expect(toolNames(requestFor("第一次"))).toContain("mcp__echo__echo");

    await openAgentPage(page, "default");
    await tab(page, "MCP");
    await rowSwitch(page, "mcpServers:echo").click();
    await expect(rowSwitch(page, "mcpServers:echo")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    expect(harnesses().default).toEqual({ mcpServers: { exclude: ["echo"] } });
    const banner = page.getByText("default 的进程还在用改之前的 MCP 设置，重启后生效。重启会打断正在进行的回合。");
    await expect(banner).toBeVisible();
    await page.getByRole("button", { name: "重启这些进程" }).click();
    await expect(banner).toHaveCount(0, { timeout: 20_000 });

    await page.getByRole("button", { name: "返回对话" }).click();
    await send(page, "第二次");
    await expect(page.getByText("没有 echo。")).toBeVisible({ timeout: 30_000 });
    expect(toolNames(requestFor("第二次"))).not.toContain("mcp__echo__echo");
  } finally {
    await app.close();
  }
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type AgentWorld, createAgentWorld, openProject as open, send } from "../helpers/agent";
import { answerFolderDialog } from "../helpers/app";

let world: AgentWorld;
const openProject = () => open(world);
/** A JSON file, or {} until it exists. */
const readJson = (path: string): Record<string, unknown> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const userSettings = () => readJson(join(world.home, ".easy-agent", "settings.json"));

test.beforeEach(async () => {
  world = await createAgentWorld();
  mkdirSync(join(world.project, ".easy-agent", "skills", "review"), { recursive: true });
  writeFileSync(
    join(world.project, ".easy-agent", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review the change before committing\n---\n\nRead the diff.\n",
  );
  writeFileSync(join(world.project, "AGENTS.md"), "# Rules\nUse pnpm for every command.\n");
});

test.afterEach(async () => {
  await world.fixture.close();
});

async function openCustomize(page: Page, tab?: string): Promise<void> {
  await page.getByRole("button", { name: /^自定义/ }).click();
  await expect(page.getByRole("heading", { name: /技能/ })).toBeVisible({ timeout: 20_000 });
  if (tab)
    await page
      .locator("nav")
      .getByRole("button", { name: new RegExp(`^${tab}`) })
      .click();
}

/** Trust the project before the app starts, so its `.mcp.json` and project settings apply. */
function trustProject(): void {
  writeFileSync(join(world.home, ".easy-agent", "state.json"), JSON.stringify({ version: 1, prefs: {}, projects: { [world.project]: { trusted: true } } }));
}

/** A stdio MCP server with one read-only `echo` tool. */
function writeEchoServer(): string {
  const path = join(world.home, "echo-server.mjs");
  const module = (specifier: string) => JSON.stringify(import.meta.resolve(`@modelcontextprotocol/sdk/${specifier}`));
  writeFileSync(
    path,
    `
import { Server } from ${module("server/index.js")};
import { StdioServerTransport } from ${module("server/stdio.js")};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${module("types.js")};
const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo the message.", inputSchema: { type: "object", properties: { message: { type: "string" } } }, annotations: { readOnlyHint: true } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] }));
await server.connect(new StdioServerTransport());
`,
  );
  return path;
}

test("skills come from the Agent, and an uploaded skill is offered after the reload", async () => {
  const source = join(world.home, "downloads", "pdf");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: pdf\ndescription: Merge PDF files\n---\n\nUse scripts/merge.py.\n");
  writeFileSync(join(source, "scripts", "merge.py"), "print('merged')\n");
  const { app, page } = await openProject();
  try {
    await openCustomize(page);
    await expect(page.getByText("/review", { exact: true })).toBeVisible();
    await page.getByText("/review", { exact: true }).click();
    await expect(page.getByText("Read the diff.")).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();

    await answerFolderDialog(app, source);
    await page.getByRole("button", { name: "上传技能" }).click();
    await page.getByRole("button", { name: "选择文件夹" }).click();
    await expect(page.getByText("找到 SKILL.md，共 2 个文件")).toBeVisible();
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await expect(page.locator("main").getByText("/pdf", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(world.project, ".easy-agent", "skills", "pdf", "scripts", "merge.py"), "utf8")).toBe("print('merged')\n");

    await page.getByRole("button", { name: "返回对话" }).click();
    await page.getByRole("textbox", { name: "消息" }).fill("/pd");
    const menu = page.getByRole("listbox", { name: "技能与命令" });
    await expect(menu.getByRole("option", { name: /\/pdf/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /\/pdf/ })).toContainText("项目");
  } finally {
    await app.close();
  }
});

test("a rule file is edited and excluded from the rules page", async () => {
  const { app, page } = await openProject();
  try {
    await openCustomize(page, "规则");
    await page.getByRole("button", { name: /AGENTS\.md\s*项目/ }).click();
    const editor = page.getByRole("textbox", { name: "规则内容" });
    await expect(editor).toHaveValue("# Rules\nUse pnpm for every command.\n");
    await editor.fill("# Rules\nUse npm.\n");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(() => readFileSync(join(world.project, "AGENTS.md"), "utf8")).toBe("# Rules\nUse npm.\n");

    await page.locator("aside").getByRole("switch").click();
    await expect.poll(() => userSettings().claudeMdExcludes).toEqual([join(world.project, "AGENTS.md")]);
    await expect(page.getByText("已排除", { exact: true }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a .mcp.json server is approved, connects, and shows in the details panel", async () => {
  trustProject();
  writeFileSync(join(world.project, ".mcp.json"), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [writeEchoServer()] } } }));
  world.fixture.script([{ kind: "text", text: "好的。" }]);
  const { app, page } = await openProject();
  try {
    await openCustomize(page, "MCP");
    await expect(page.getByText("项目的 .mcp.json 声明了 1 个服务器，还没有启动。")).toBeVisible();
    await page.getByRole("button", { name: "批准", exact: true }).click();
    await expect(page.getByText("已连接", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(readJson(join(world.project, ".easy-agent", "settings.local.json"))).toEqual({ enabledMcpjsonServers: ["echo"] });

    await page.getByRole("button", { name: "返回对话" }).click();
    await send(page, "你好");
    await expect(page.getByText("好的。")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Meta+j");
    await page.getByRole("tab", { name: "后台" }).click();
    await expect(page.getByLabel("详情面板").getByText("1 个工具")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a global MCP server is added and connects after the Agent restarts", async () => {
  const server = writeEchoServer();
  const { app, page } = await openProject();
  try {
    await openCustomize(page, "MCP");
    await page.getByRole("button", { name: "添加服务器" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("例如 github").fill("echo");
    await dialog.getByPlaceholder("npx -y @modelcontextprotocol/server-github").fill(`${process.execPath} ${server}`);
    await dialog.getByRole("button", { name: "添加并连接" }).click();
    await expect.poll(() => (userSettings().mcpServers as Record<string, unknown> | undefined)?.echo).toEqual({ command: process.execPath, args: [server] });
    await expect(page.getByText("已连接", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});

test("a hook is added to the chosen settings file", async () => {
  const { app, page } = await openProject();
  try {
    await openCustomize(page, "Hooks");
    await page.getByRole("button", { name: "添加 Hook" }).click();
    await page.getByPlaceholder("npx prettier --write $(jq -r .tool_input.file_path)").fill("echo formatted");
    await page.getByRole("dialog").getByRole("button", { name: /^全局/ }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect
      .poll(() => (userSettings().hooks as Record<string, unknown> | undefined)?.PostToolUse)
      .toEqual([{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo formatted" }] }]);
    await expect(page.getByText("echo formatted", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the context panel splits the next request by category", async () => {
  world.fixture.script([{ kind: "text", text: "收到。" }]);
  const { app, page } = await openProject();
  try {
    await send(page, "看一下上下文");
    await expect(page.getByText("收到。")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Meta+j");
    await page.getByRole("tab", { name: "上下文" }).click();
    const panel = page.getByLabel("详情面板");
    for (const label of ["系统提示词", "内置工具", "技能", "规则", "对话消息"]) {
      await expect(panel.getByText(label, { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await expect(panel.getByText(/· 估算/)).toBeVisible();
    await panel.getByRole("button", { name: /^规则/ }).click();
    await expect(panel.getByText("AGENTS.md", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "在自定义中管理" }).click();
    await expect(page.getByRole("heading", { name: /规则/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

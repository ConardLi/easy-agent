import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type AgentWorld, createAgentWorld, openProject as open, send } from "../helpers/agent";

let world: AgentWorld;
const openProject = () => open(world);

test.beforeEach(async () => {
  world = await createAgentWorld();
});

test.afterEach(async () => {
  await world.fixture.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("permission requests are answered from the card, and the change shows in the panel", async () => {
  world.fixture.script([
    { kind: "tool", name: "Write", input: { file_path: join(world.project, "notes.md"), content: "one\ntwo\n" } },
    { kind: "tool", name: "Write", input: { file_path: join(world.project, "denied.md"), content: "x" } },
    { kind: "text", text: "写好了一个文件。" },
  ]);
  const { app, page } = await openProject();
  try {
    await send(page, "写两个文件");
    await expect(page.getByText("允许 Easy Agent 创建文件")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "消息" })).toHaveAttribute("placeholder", "先处理上面的请求，或按 Esc 中断");
    await page.getByRole("button", { name: /^允许一次/ }).click();
    await expect(page.getByText("已允许一次")).toBeVisible();

    await expect(page.getByText("允许 Easy Agent 创建文件")).toBeVisible({ timeout: 20_000 });
    // Keyboard: 3 denies the request that is waiting.
    await page.keyboard.press("3");
    await expect(page.getByRole("button", { name: "已拒绝 denied.md" })).toBeVisible();
    await expect(page.getByText("写好了一个文件。")).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(world.project, "notes.md"), "utf8")).toBe("one\ntwo\n");
    expect(existsSync(join(world.project, "denied.md"))).toBe(false);

    await page.getByRole("button", { name: "详情面板" }).click();
    const panel = page.getByRole("complementary", { name: "详情面板" });
    await expect(panel.getByText("notes.md")).toBeVisible();
    await expect(panel.getByText("denied.md")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("a plan is approved from its card and the implementation turn follows", async () => {
  world.fixture.script([
    { kind: "tool", name: "ExitPlanMode", input: { summary: "改 README", plan: "# 计划\n\n1. 把 README 的标题改成 Demo project" } },
    { kind: "text", text: "按计划改好了。" },
  ]);
  const { app, page } = await openProject();
  try {
    await page.getByRole("button", { name: "默认", exact: true }).click();
    await page.getByRole("menuitem", { name: /计划/ }).click();
    await send(page, "先出计划");
    await expect(page.getByText("计划已就绪，等你确认")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("把 README 的标题改成 Demo project")).toBeVisible();
    await page.getByRole("button", { name: /^批准并执行/ }).click();
    await expect(page.getByText("已批准计划")).toBeVisible();
    await expect(page.getByText("按计划改好了。")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("a question is answered by picking an option", async () => {
  world.fixture.script([
    {
      kind: "tool",
      name: "AskUserQuestion",
      input: {
        questions: [{ question: "用哪个包管理器？", header: "工具", options: [{ label: "npm", description: "仓库现在用的" }, { label: "pnpm" }] }],
      },
    },
    { kind: "text", text: "好，用 npm。" },
  ]);
  const { app, page } = await openProject();
  try {
    await send(page, "问我一个问题");
    await expect(page.getByText("需要你做个选择")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /npm 仓库现在用的/ }).click();
    await page.getByRole("button", { name: /^提交/ }).click();
    await expect(page.getByText("已回答 1 个问题")).toBeVisible();
    await expect(page.getByText("好，用 npm。")).toBeVisible({ timeout: 20_000 });
    const answer = JSON.stringify(world.fixture.requests.at(-1)?.messages);
    expect(answer).toContain("npm");
  } finally {
    await app.close();
  }
});

test("the permission mode switches while a turn runs", async () => {
  world.fixture.script([{ kind: "text", text: "慢慢回答。", delayMs: 3000 }]);
  const { app, page } = await openProject();
  try {
    await send(page, "开始");
    await expect(page.getByRole("button", { name: "中断" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "默认", exact: true }).click();
    await page.getByRole("menuitem", { name: /自动/ }).click();
    await expect(page.getByText("已切换到自动模式")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "中断" })).toBeVisible();
    await expect(page.getByText("慢慢回答。")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("slash offers skills and Agent commands, and UI aliases open their control", async () => {
  const { app, page } = await openProject();
  try {
    const input = page.getByRole("textbox", { name: "消息" });
    await input.fill("/");
    const menu = page.getByRole("listbox", { name: "技能与命令" });
    await expect(menu.getByRole("option", { name: /\/compact/ })).toBeVisible();
    await expect(menu.getByRole("option", { name: /\/init/ })).toBeVisible();
    await expect(menu.getByText("切换模型")).toHaveCount(0);

    await input.fill("/mo");
    await expect(menu.getByRole("option", { name: /切换模型/ })).toBeVisible();
    await input.press("Enter");
    await expect(page.getByPlaceholder("输入模型名称或配置里的模型句柄")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("@ completes workspace files and images go to the model", async () => {
  world.fixture.script([{ kind: "text", text: "看到了一个像素。" }]);
  const { app, page } = await openProject();
  try {
    const input = page.getByRole("textbox", { name: "消息" });
    await input.fill("看看 @REA");
    const files = page.getByRole("listbox", { name: "文件" });
    await expect(files.getByRole("option", { name: /README\.md/ })).toBeVisible();
    await input.press("Enter");
    await expect(input).toHaveValue("看看 @README.md ");

    await page.getByLabel("选择图片").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(PNG, "base64") });
    await expect(page.getByRole("button", { name: "移除附件" })).toBeAttached();
    await input.press("Enter");
    await expect(page.getByText("看到了一个像素。")).toBeVisible({ timeout: 20_000 });
    const sent = JSON.stringify(world.fixture.requests.at(-1)?.messages);
    expect(sent).toContain('"type":"image"');
    expect(sent).toContain("@README.md");
  } finally {
    await app.close();
  }
});

test("a session exports to Markdown", async () => {
  world.fixture.script([{ kind: "text", text: "导出这段回答。" }]);
  const { app, page } = await openProject();
  const target = join(world.project, "..", "export.md");
  try {
    await send(page, "准备导出");
    await expect(page.getByText("导出这段回答。")).toBeVisible({ timeout: 20_000 });
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, target);
    await page.getByRole("button", { name: "会话操作" }).click();
    await page.getByRole("menuitem", { name: "导出为 Markdown" }).click();
    await expect(page.getByText("已导出")).toBeVisible();
    const markdown = readFileSync(target, "utf8");
    expect(markdown).toContain("# 准备导出");
    expect(markdown).toContain("## 你\n\n准备导出");
    expect(markdown).toContain("## Easy Agent\n\n导出这段回答。");
  } finally {
    await app.close();
  }
});

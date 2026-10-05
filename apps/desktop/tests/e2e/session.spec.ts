import { execSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type AgentWorld, createAgentWorld, openProject as open, send, sessionRow } from "../helpers/agent";
import { launchApp } from "../helpers/app";

let world: AgentWorld;
const openProject = () => open(world);

test.beforeEach(async () => {
  world = await createAgentWorld();
});

test.afterEach(async () => {
  await world.fixture.close();
});

test("a conversation streams from the Agent and shows up in the session list", async () => {
  world.fixture.script([{ kind: "text", text: "你好，我是测试模型。" }]);
  const { app, page } = await openProject();
  try {
    await send(page, "你好");
    await expect(page.getByText("你好，我是测试模型。")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".rounded-br-\\[6px\\]", { hasText: "你好" })).toBeVisible();
    await expect(sessionRow(page, "你好")).toBeVisible();
    await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a tool call renders as a card with its result", async () => {
  world.fixture.script([
    { kind: "tool", name: "Read", input: { file_path: join(world.project, "README.md") } },
    { kind: "text", text: "读完了，这是一个演示项目。" },
  ]);
  const { app, page } = await openProject();
  try {
    await send(page, "读一下 README");
    await expect(page.getByText("读完了，这是一个演示项目。")).toBeVisible({ timeout: 20_000 });
    const row = page.getByRole("button", { name: /读取\s*README\.md/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("3 行");
  } finally {
    await app.close();
  }
});

test("interrupting stops the running turn", async () => {
  world.fixture.script([{ kind: "text", text: "这条回复不应该出现。", delayMs: 8000 }]);
  const { app, page } = await openProject();
  try {
    await send(page, "慢慢来");
    const stop = page.getByRole("button", { name: "中断" });
    await expect(stop).toBeVisible({ timeout: 20_000 });
    await stop.click();
    await expect(page.getByText("已中断")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
    await expect(page.getByText("这条回复不应该出现。")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("the workspace and its last session come back after a restart", async () => {
  world.fixture.script([{ kind: "text", text: "第一次的回答。" }]);
  const first = await openProject();
  await send(first.page, "记住我");
  await expect(first.page.getByText("第一次的回答。")).toBeVisible({ timeout: 20_000 });
  await first.app.close();

  const second = await launchApp({ userData: first.userData, env: world.env });
  try {
    await expect(second.page.getByText("第一次的回答。")).toBeVisible({ timeout: 20_000 });
    await expect(sessionRow(second.page, "记住我")).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test("sessions can be renamed, forked, and deleted", async () => {
  world.fixture.script([{ kind: "text", text: "好的。" }]);
  const { app, page } = await openProject();
  try {
    await send(page, "原来的标题");
    await expect(page.getByText("好的。")).toBeVisible({ timeout: 20_000 });
    const row = sessionRow(page, "原来的标题");
    await expect(row).toBeVisible();

    await row.dblclick();
    const input = page.getByRole("textbox", { name: "会话名称" });
    await input.fill("新的标题");
    await input.press("Enter");
    await expect(sessionRow(page, "新的标题")).toBeVisible();
    await expect(page.locator("header h1")).toHaveText("新的标题");

    await page.getByRole("button", { name: "会话操作" }).click();
    await page.getByRole("menuitem", { name: "分叉会话" }).click();
    await expect(page.getByText("已分叉为新会话")).toBeVisible();
    const fork = sessionRow(page, "新的标题（分叉）");
    await expect(fork).toBeVisible();
    await expect(page.locator("header h1")).toHaveText("新的标题（分叉）");
    await expect(page.getByText("好的。")).toBeVisible();

    await fork.hover();
    await fork.locator("xpath=..").getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(page.getByText("会话已删除")).toBeVisible();
    await expect(fork).toHaveCount(0);
    await expect(sessionRow(page, "新的标题")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("switching the permission mode is reported in the conversation", async () => {
  world.fixture.script([{ kind: "text", text: "收到。" }]);
  const { app, page } = await openProject();
  try {
    await send(page, "开始");
    await expect(page.getByText("收到。")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "默认", exact: true }).click();
    await page.getByRole("menuitem", { name: /计划/ }).click();
    await expect(page.getByText("已切换到计划模式")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "计划", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a crashed Agent process restarts and reopens its sessions", async () => {
  world.fixture.script([
    { kind: "text", text: "崩溃前的回答。" },
    { kind: "text", text: "重启后的回答。" },
  ]);
  const { app, page } = await openProject();
  try {
    await send(page, "第一句");
    await expect(page.getByText("崩溃前的回答。")).toBeVisible({ timeout: 20_000 });

    // Kill the workspace's `eagent --rpc` child of the app.
    execSync(`pkill -KILL -P ${app.process().pid} -f -- "--rpc"`);
    await expect(page.getByText("Agent 进程退出了，正在重新启动。")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Agent 进程退出了，正在重新启动。")).toHaveCount(0, { timeout: 20_000 });
    // The composer takes input again once the restarted process is ready.
    await expect(page.getByPlaceholder("继续对话")).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText("崩溃前的回答。")).toBeVisible();
    await send(page, "第二句");
    await expect(page.getByText("重启后的回答。")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("reloading the window picks the open session back up from the Agent", async () => {
  world.fixture.script([{ kind: "text", text: "刷新前的回答。" }]);
  const { app, page } = await openProject();
  try {
    await send(page, "刷新试试");
    await expect(page.getByText("刷新前的回答。")).toBeVisible({ timeout: 20_000 });
    await page.reload();
    await expect(page.getByText("刷新前的回答。")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
  } finally {
    await app.close();
  }
});

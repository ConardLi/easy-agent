import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAgentWorld, openProject, send } from "../helpers/agent";
import { completedReplays, replayRequests } from "../helpers/requestReplay";
import { COMPARISON_FIXTURE, CONTEXT_FIXTURE } from "../visual/requestFixtures";

test("request provenance links to the session Agent and disabling a skill removes it from the next request", async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const world = await createAgentWorld();
  mkdirSync(join(world.home, ".easy-agent", "skills", "review"), { recursive: true });
  writeFileSync(join(world.home, ".easy-agent", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code carefully\n---\nCheck the code.");
  writeFileSync(
    join(world.home, ".easy-agent", "settings.json"),
    JSON.stringify({
      model: "counted",
      harnesses: { reviewer: {} },
      models: {
        counted: {
          protocol: "anthropic",
          model: "fixture-counted",
          baseURL: world.fixture.baseURL,
          apiKey: "${EASY_AGENT_API_KEY}",
          protocolOptions: { anthropic: { countTokens: true } },
        },
      },
    }),
  );
  world.fixture.countTokens("on");
  world.fixture.script([
    { kind: "text", text: "第一次完成。", cache: { read: 80, write: 20 } },
    { kind: "text", text: "第二次完成。" },
  ]);
  const { app, page } = await openProject(world);
  try {
    await page
      .locator("aside")
      .getByRole("button", { name: /^Agent/ })
      .click();
    await page.locator('[data-agent="reviewer"]').click();
    await page.getByRole("button", { name: "用它新建会话" }).click();
    await send(page, "检查第一轮");
    await expect(page.getByText("第一次完成。")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "详情面板", exact: true }).click();
    await page.getByRole("tab", { name: "上下文", exact: true }).click();
    const panel = page.getByLabel("详情面板");
    await expect(panel.getByText("最近实际请求", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText("提供方计数 · 组件按比例分摊")).toBeVisible();
    await expect(panel.getByText("缓存读取")).toBeVisible();
    await expect(panel.locator('[data-metric="缓存读取"]')).toContainText("80");
    await expect(panel.getByText(/尚未发送/)).toBeVisible();
    await panel.getByRole("button", { name: /^技能/ }).click();
    const skill = panel.locator('[data-component="skill:user:review"]');
    await skill.getByRole("button", { name: /review/ }).click();
    await expect(skill.getByText("来源：全局")).toBeVisible();
    await page.locator("[data-context-viewport]").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath("request-context.png"), animations: "disabled" });
    await skill.getByRole("button", { name: "在 Harness 中配置" }).click();
    const harness = page.locator('[data-harness="reviewer"]');
    await expect(harness).toBeVisible();
    const row = harness.locator('[data-row="skills:review"]');
    await expect(row).toBeFocused();
    await row.getByRole("switch").click();
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false", { timeout: 20_000 });
    await page.screenshot({ path: testInfo.outputPath("request-configure.png"), animations: "disabled" });
    await page.getByRole("button", { name: "返回对话" }).click();
    // The recorded request remains unchanged until another request is actually sent.
    await panel.getByRole("button", { name: /^技能/ }).click();
    await expect(panel.locator('[data-component="skill:user:review"]')).toBeVisible();
    await send(page, "检查第二轮");
    await expect(page.getByText("第二次完成。")).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('[data-component="skill:user:review"]')).toHaveCount(0, { timeout: 20_000 });
    await page.locator("[data-context-viewport]").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath("request-context-after.png"), animations: "disabled" });
    expect(JSON.stringify(world.fixture.requests[0]?.system)).toContain("Review code carefully");
    expect(JSON.stringify(world.fixture.requests.at(-1)?.system)).not.toContain("Review code carefully");
  } finally {
    await app.close();
    await world.fixture.close();
  }
});

test("context errors can be retried and a late comparison cannot replace edited input", async () => {
  const world = await createAgentWorld();
  const userFile = join(world.home, ".easy-agent", "settings.json");
  writeFileSync(userFile, JSON.stringify({ ...JSON.parse(readFileSync(userFile, "utf8")), harnesses: { lean: {} } }));
  world.fixture.script([{ kind: "text", text: "收到。" }]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "检查上下文");
    await expect(page.getByText("收到。")).toBeVisible({ timeout: 20_000 });
    await replayRequests(app, { context: CONTEXT_FIXTURE, error: "上下文读取失败" });
    await page.getByRole("button", { name: "详情面板", exact: true }).click();
    await page.getByRole("tab", { name: "上下文" }).click();
    const panel = page.getByLabel("详情面板");
    await expect(panel.getByRole("alert")).toContainText("上下文读取失败");
    await replayRequests(app, { context: CONTEXT_FIXTURE });
    await panel.getByRole("button", { name: "重试" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByText(/req-context-01/)).toBeVisible();
    await panel.getByRole("button", { name: "请求对比" }).click();
    const dialog = page.getByRole("dialog", { name: "请求对比" });
    await dialog.getByLabel("共同输入").fill("第一段输入");
    await replayRequests(app, { comparison: COMPARISON_FIXTURE, error: "请求渲染失败" });
    await dialog.getByRole("button", { name: "生成对比" }).click();
    await expect(dialog.getByRole("alert")).toContainText("请求渲染失败");
    await replayRequests(app, { comparison: COMPARISON_FIXTURE, delay: 1000 });
    await dialog.getByRole("button", { name: "生成对比" }).click();
    await dialog.getByLabel("共同输入").fill("已经换了输入");
    await expect.poll(() => completedReplays(app)).toBe(1);
    await expect(dialog.locator("[data-diff-component]")).toHaveCount(0);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "生成对比" }).click();
    await expect(dialog.locator('[data-diff-component="tool:Bash"]')).toBeVisible();
  } finally {
    await app.close();
    await world.fixture.close();
  }
});

test("compare two Agents for one input without model calls, and invalidate the result when input changes", async () => {
  const testInfo = test.info();
  const world = await createAgentWorld();
  writeFileSync(
    join(world.home, ".easy-agent", "settings.json"),
    JSON.stringify({
      ...JSON.parse(readFileSync(join(world.home, ".easy-agent", "settings.json"), "utf8")),
      harnesses: { lean: { tools: { exclude: ["Bash"] }, prompt: { identity: { text: "You are a concise reviewer." } } } },
    }),
  );
  const { app, page } = await openProject(world);
  try {
    await page
      .locator("aside")
      .getByRole("button", { name: /^Agent/ })
      .click();
    await page.getByRole("button", { name: "请求对比", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "请求对比" });
    await dialog.getByLabel("Agent A", { exact: true }).selectOption("default");
    await dialog.getByLabel("Agent B", { exact: true }).selectOption("lean");
    await dialog.getByLabel("共同输入").fill("检查这个项目");
    await dialog.getByRole("button", { name: "生成对比", exact: true }).click();
    await expect(dialog.locator('[data-diff-component="tool:Bash"]')).toContainText("移除", { timeout: 20_000 });
    await page.screenshot({ path: testInfo.outputPath("request-comparison-overview.png"), animations: "disabled" });
    const identity = dialog.locator('[data-diff-component="prompt_section:identity"]');
    await identity.getByRole("button").click();
    await expect(identity).toContainText("You are a concise reviewer.");
    await expect(identity).toContainText("You are Easy Agent");
    await expect(dialog.getByText("全部 token 均为估算")).toBeVisible();
    expect(world.fixture.requests).toHaveLength(0);
    expect(world.fixture.countRequests).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("request-comparison.png"), animations: "disabled" });
    await dialog.getByLabel("共同输入").fill("换一段输入");
    await expect(dialog.locator("[data-diff-component]")).toHaveCount(0);
    await dialog.getByLabel("Agent B", { exact: true }).selectOption("default");
    await dialog.getByRole("button", { name: "生成对比", exact: true }).click();
    await expect(dialog.getByText("两份请求的组件完全相同")).toBeVisible({ timeout: 20_000 });
    expect(world.fixture.requests).toHaveLength(0);
  } finally {
    await app.close();
    await world.fixture.close();
  }
});

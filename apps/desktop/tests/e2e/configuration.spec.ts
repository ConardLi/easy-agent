import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createAgentWorld, openProject, send, type AgentWorld } from "../helpers/agent";

let world: AgentWorld;
const file = () => join(world.home, ".easy-agent", "settings.json");
const settings = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
const profile = () => (settings().models as Record<string, Record<string, unknown>>)["fixture-model"]!;
async function models(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "默认模型", exact: true })).toBeVisible();
}
test.beforeEach(async () => {
  world = await createAgentWorld();
});
test.afterEach(async () => {
  await world.fixture.close();
});

test("no-profile startup keeps settings available and explains the first model request", async ({ baseURL: _baseURL }, info) => {
  writeFileSync(file(), "{}");
  const { app, page } = await openProject(world);
  try {
    await models(page);
    await expect(page.getByRole("status")).toContainText("还没有配置模型");
    await page.screenshot({ path: info.outputPath("no-profile-configuration.png"), animations: "disabled" });
    const budget = page.getByRole("spinbutton", { name: "推理预算", exact: true });
    await expect(budget).toHaveValue("");
    await budget.fill("2000");
    await budget.blur();
    await expect
      .poll(() => (settings().harnesses as Record<string, { reasoning?: { budgetTokens?: number } }> | undefined)?.default?.reasoning?.budgetTokens)
      .toBe(2000);
    await budget.fill("");
    await budget.blur();
    await expect
      .poll(() => (settings().harnesses as Record<string, { reasoning?: { budgetTokens?: number } }> | undefined)?.default?.reasoning?.budgetTokens)
      .toBeUndefined();
    await expect(budget).toHaveValue("");
    const notices = page.getByRole("button", { name: /^已写入 harnesses\.default\.reasoning\.budgetTokens$/ });
    while (await notices.count()) {
      const count = await notices.count();
      await notices.first().click();
      await expect(notices).toHaveCount(count - 1);
    }
    await page.locator('[data-row="reasoning.budgetTokens"]').screenshot({ path: info.outputPath("reasoning-budget-auto.png"), animations: "disabled" });
    await page.getByRole("button", { name: "返回对话", exact: true }).click();
    await send(page, "检查这个项目");
    await expect(page.getByRole("main").getByText(/no model profile is configured/)).toBeVisible();
    expect(world.fixture.requests).toHaveLength(0);
    await models(page);
    await expect(page.getByRole("button", { name: "Anthropic", exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("unknown settings remain visible as diagnostics and block model use without rewriting the file", async () => {
  const original = JSON.stringify({ ...settings(), unknownOption: "private-invalid-value" });
  writeFileSync(file(), original);
  const { app, page } = await openProject(world);
  try {
    await send(page, "检查配置");
    await expect(page.getByRole("main").getByText(/unknown setting "unknownOption"/)).toBeVisible();
    expect(world.fixture.requests).toHaveLength(0);
    await models(page);
    await expect(page.getByRole("button", { name: "Anthropic", exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("private-invalid-value");
    expect(readFileSync(file(), "utf8")).toBe(original);
  } finally {
    await app.close();
  }
});

test("ambient vendor credentials do not override the selected profile", async () => {
  const canonical = { ...profile(), apiKey: "${EASY_AGENT_API_KEY}" };
  writeFileSync(
    file(),
    JSON.stringify({
      ...settings(),
      models: { "fixture-model": canonical },
      harnesses: { default: { model: { main: "fixture-model" } } },
      env: { EASY_AGENT_API_KEY: "fixture-token", ANTHROPIC_API_KEY: "ambient-key", ANTHROPIC_AUTH_TOKEN: "ambient-token" },
    }),
  );
  world.fixture.script([{ kind: "text", text: "使用所选连接" }]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "检查已保存连接");
    expect(profile()).toEqual(canonical);
    await expect(page.getByRole("main").getByText("使用所选连接", { exact: true })).toBeVisible();
    expect(world.fixture.requests.at(-1)?.headers["x-api-key"]).toBe("fixture-token");
    expect(world.fixture.requests.at(-1)?.headers.authorization).toBeUndefined();
  } finally {
    await app.close();
  }
});

test("custom authentication and a profile helper survive reload; no-auth removes credentials", async ({ baseURL: _baseURL }, info) => {
  writeFileSync(
    file(),
    JSON.stringify({
      ...settings(),
      models: {
        "fixture-model": {
          ...profile(),
          apiKey: { helper: `${JSON.stringify(process.execPath)} -e "process.stdout.write('helper-fixture')"` },
          authentication: { type: "header", name: "X-Gateway-Credential", prefix: "Key " },
          protocolOptions: { anthropic: { countTokens: false, adaptiveThinking: false } },
          capabilities: { contextWindow: 32000, reasoning: false, vision: false, tools: true },
        },
      },
    }),
  );
  world.fixture.script([
    { kind: "text", text: "ok" },
    { kind: "text", text: "ok" },
  ]);
  let { app, page } = await openProject(world);
  try {
    await models(page);
    await page
      .getByRole("button", { name: /127\.0\.0\.1/ })
      .first()
      .click();
    await expect(page.getByLabel("认证头名称")).toHaveValue("X-Gateway-Credential");
    await page.getByRole("button", { name: "检测", exact: true }).click();
    await expect(page.getByText(/连接正常 · \d+ms/)).toBeVisible({ timeout: 20000 });
    expect(world.fixture.requests.at(-1)?.headers["x-gateway-credential"]).toBe("Key helper-fixture");
    expect(world.fixture.requests.at(-1)?.headers["x-api-key"]).toBeUndefined();
    const name = page.getByLabel("认证头名称");
    await name.fill("X-Second-Credential");
    await name.blur();
    await expect.poll(() => profile().authentication).toEqual({ type: "header", name: "X-Second-Credential", prefix: "Key " });
    await page.getByRole("button", { name: "高级设置", exact: true }).click();
    await expect(page.getByText("API Key 辅助命令", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("profile-helper-custom-auth.png"), animations: "disabled" });
    await page.getByLabel("API Key 辅助命令").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("profile-helper-advanced.png"), animations: "disabled" });
    await app.close();
    ({ app, page } = await openProject(world));
    await models(page);
    await page
      .getByRole("button", { name: /127\.0\.0\.1/ })
      .first()
      .click();
    await expect(page.getByLabel("认证头名称")).toHaveValue("X-Second-Credential");
    await page
      .getByRole("combobox")
      .filter({ has: page.getByRole("option", { name: "自定义认证头", exact: true }) })
      .selectOption("none");
    await expect.poll(() => profile().authentication).toEqual({ type: "none" });
    expect(profile().apiKey).toBeUndefined();
    expect(profile().protocolOptions).toEqual({ anthropic: { countTokens: false, adaptiveThinking: false } });
    await page.getByRole("button", { name: "检测", exact: true }).click();
    await expect(page.getByText(/连接正常 · \d+ms/)).toBeVisible({ timeout: 20000 });
    expect(world.fixture.requests.at(-1)?.headers["x-second-credential"]).toBeUndefined();
    expect(world.fixture.requests.at(-1)?.headers["x-api-key"]).toBeUndefined();
    await page.screenshot({ path: info.outputPath("profile-no-auth.png"), animations: "disabled" });
  } finally {
    await app.close();
  }
});

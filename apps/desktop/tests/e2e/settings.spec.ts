import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type AgentWorld, createAgentWorld, openProject as open } from "../helpers/agent";

let world: AgentWorld;
const openProject = () => open(world);
const userSettings = () => JSON.parse(readFileSync(join(world.home, ".easy-agent", "settings.json"), "utf8")) as Record<string, unknown>;

test.beforeEach(async () => {
  world = await createAgentWorld();
});

test.afterEach(async () => {
  await world.fixture.close();
});

async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: section, exact: true }).click();
}

test("behavior and permission edits are written to the chosen settings file", async () => {
  writeFileSync(join(world.home, ".easy-agent", "settings.json"), JSON.stringify({ maxTurns: 120 }));
  const { app, page } = await openProject();
  try {
    await openSettings(page, "行为");
    const turns = page.getByRole("spinbutton").first();
    await expect(turns).toHaveValue("120");
    await turns.fill("80");
    await turns.blur();
    await expect.poll(() => userSettings().maxTurns).toBe(80);

    await page.getByRole("button", { name: "权限", exact: true }).click();
    await page.getByRole("button", { name: /^拒绝 \d+$/ }).click();
    const rule = page.getByPlaceholder(/Bash\(pnpm lint/);
    await rule.fill("Bash(rm -rf:*)");
    await rule.press("Enter");
    await expect.poll(() => userSettings().deny).toEqual(["Bash(rm -rf:*)"]);

    // The project file cannot set the default permission mode.
    await page.getByRole("button", { name: /^项目/ }).click();
    await expect(page.getByText("只能写在全局设置", { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a provider is configured, checked, and offered in the composer", async () => {
  world.fixture.script([{ kind: "text", text: "pong" }]);
  const { app, page } = await openProject();
  try {
    await openSettings(page, "模型");
    await page.getByRole("button", { name: "Anthropic", exact: true }).click();
    const key = page.getByPlaceholder("sk-...");
    await key.fill("${ANTHROPIC_AUTH_TOKEN}");
    await key.blur();
    const url = page.getByPlaceholder("https://api.example.com/v1");
    await url.fill(world.env.ANTHROPIC_BASE_URL!);
    await url.blur();
    await expect
      .poll(() => Object.values((userSettings().models ?? {}) as Record<string, { baseURL?: string; apiKey?: string }>)[0])
      .toMatchObject({ protocol: "anthropic", baseURL: world.env.ANTHROPIC_BASE_URL, apiKey: "${ANTHROPIC_AUTH_TOKEN}" });

    await page.getByRole("button", { name: "检测" }).click();
    await expect(page.getByText(/连接正常 · \d+ms/)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "返回对话" }).click();
    await page.getByRole("button", { name: "默认模型" }).click();
    await expect(page.getByRole("button", { name: /Claude Opus 4\.1/ })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("workspace trust is saved and revoked from the settings", async () => {
  const { app, page } = await openProject();
  try {
    await openSettings(page, "环境与凭据");
    await page.getByRole("button", { name: "始终信任" }).click();
    await expect(page.getByText("已信任", { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(join(world.home, ".easy-agent", "state.json"), "utf8")).toContain('"trusted": true');
    await page.getByRole("button", { name: "撤销" }).click();
    await expect(page.getByText("未信任", { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("sending with ⌘Enter leaves Enter for new lines", async () => {
  world.fixture.script([{ kind: "text", text: "收到。" }]);
  const { app, page } = await openProject();
  try {
    await openSettings(page, "通用");
    await page
      .getByRole("button", { name: /Enter$/ })
      .last()
      .click();
    await page.getByRole("button", { name: "返回对话" }).click();
    const input = page.getByRole("textbox", { name: "消息" });
    await input.fill("第一行");
    await input.press("Enter");
    await expect(input).toHaveValue("第一行\n");
    await input.press("Meta+Enter");
    await expect(page.getByText("收到。")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

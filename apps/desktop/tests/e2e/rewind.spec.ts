import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type AgentWorld, createAgentWorld, openProject, send } from "../helpers/agent";

let world: AgentWorld;

test.beforeEach(async () => {
  world = await createAgentWorld();
  // User settings apply in an untrusted workspace, so writes go through without a card.
  writeFileSync(join(world.home, ".easy-agent", "settings.json"), JSON.stringify({ allow: ["Write"] }));
});

test.afterEach(async () => {
  await world.fixture.close();
});

/** Open the rewind menu of the prompt that reads `text`. */
async function rewindMenu(page: Page, text: string): Promise<void> {
  const message = page.locator(".group\\/user").filter({ hasText: text });
  await message.hover();
  await message.getByRole("button", { name: "回退" }).click();
}

test("rewinding files, the conversation, everything, and forking from a prompt", async () => {
  const file = (name: string) => join(world.project, name);
  world.fixture.script([
    { kind: "tool", name: "Write", input: { file_path: file("notes.md"), content: "one\n" } },
    { kind: "text", text: "写好第一版。" },
  ]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "第一版");
    await expect(page.getByText("写好第一版。")).toBeVisible({ timeout: 20_000 });
    world.fixture.script([
      { kind: "tool", name: "Write", input: { file_path: file("notes.md"), content: "two\n" } },
      { kind: "tool", name: "Write", input: { file_path: file("extra.md"), content: "x\n" } },
      { kind: "text", text: "写好第二版。" },
    ]);
    await send(page, "第二版");
    await expect(page.getByText("写好第二版。")).toBeVisible({ timeout: 20_000 });

    // Files only: the dialog lists what changes; the conversation stays.
    await rewindMenu(page, "第二版");
    await page.getByRole("menuitem", { name: /只回退代码/ }).click();
    const filesDialog = page.getByRole("dialog", { name: "只回退代码" });
    await expect(filesDialog.getByText("notes.md")).toBeVisible();
    await expect(filesDialog.getByText("extra.md")).toBeVisible();
    await filesDialog.getByRole("button", { name: "回退文件" }).click();
    await expect(page.getByText("已把 2 个文件恢复到这条消息之前")).toBeVisible();
    expect(readFileSync(file("notes.md"), "utf8")).toBe("one\n");
    expect(existsSync(file("extra.md"))).toBe(false);
    await expect(page.getByText("写好第二版。")).toBeVisible();

    // Conversation and code: the turn goes, its prompt waits in the composer.
    await rewindMenu(page, "第二版");
    await page.getByRole("menuitem", { name: /回退对话和代码/ }).click();
    await page.getByRole("dialog", { name: "回退对话和代码" }).getByRole("button", { name: "回退", exact: true }).click();
    await expect(page.getByText("写好第二版。")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("第二版");
    await expect(page.getByText("写好第一版。")).toBeVisible();

    // Every change of the session, from the Changes panel.
    await page.getByRole("button", { name: "详情面板" }).click();
    const panel = page.getByRole("complementary", { name: "详情面板" });
    await expect(panel.getByText("notes.md")).toBeVisible();
    await panel.getByRole("button", { name: "全部回退" }).click();
    const allDialog = page.getByRole("dialog", { name: "全部回退" });
    await expect(allDialog.getByText("notes.md")).toBeVisible();
    await allDialog.getByRole("button", { name: "回退文件" }).click();
    await expect(panel.getByText("还没有文件改动")).toBeVisible();
    expect(existsSync(file("notes.md"))).toBe(false);

    // A fork from the first prompt opens a new session with the prompt in the composer.
    await page.getByRole("textbox", { name: "消息" }).fill("");
    await rewindMenu(page, "第一版");
    await page.getByRole("menuitem", { name: /从这里分叉/ }).click();
    await expect(page.getByText("已从这条消息分叉为新会话")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息" })).toHaveValue("第一版");
    await expect(page.getByText("写好第一版。")).toHaveCount(0);
    await expect(page.locator("nav").getByText(/（分叉）/)).toBeVisible();
  } finally {
    await app.close();
  }
});

test("regenerating runs the last prompt again in place of its reply", async () => {
  const long = (label: string) => `${label}：${"这是一段足够长的回答，用来显示复制和重新生成按钮。".repeat(6)}`;
  world.fixture.script([{ kind: "text", text: long("第一次回答") }]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "讲讲这个项目");
    await expect(page.getByText(/第一次回答/)).toBeVisible({ timeout: 20_000 });
    world.fixture.script([{ kind: "text", text: long("第二次回答") }]);
    const requests = world.fixture.requests.length;
    await page.getByText(/第一次回答/).hover();
    await page.getByRole("button", { name: "重新生成" }).click();
    await expect(page.getByText(/第二次回答/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/第一次回答/)).toHaveCount(0);
    await expect(page.locator(".group\\/user").filter({ hasText: "讲讲这个项目" })).toHaveCount(1);
    const sent = JSON.stringify(world.fixture.requests[requests]?.messages);
    expect(sent).toContain("讲讲这个项目");
    expect(sent).not.toContain("第一次回答");
  } finally {
    await app.close();
  }
});

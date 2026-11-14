import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { RecordedRequest } from "../../../../src/scripts/fixtures/anthropicFixture";
import { type AgentWorld, createAgentWorld, openProject, send, sessionRow } from "../helpers/agent";
import { launchApp } from "../helpers/app";

let world: AgentWorld;

const REVIEWER_IDENTITY = "You are the reviewer Agent. Review changes; never edit files.";
const LEFT_OUT = ["Write", "Edit", "MultiEdit", "Bash"];

/** `harnesses` in the user settings file of the world's home. */
function writeAgents(harnesses: Record<string, unknown>): void {
  const file = join(world.home, ".easy-agent", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No settings yet.
  }
  writeFileSync(file, JSON.stringify({ ...settings, harnesses }));
}

const reviewer = (identity = REVIEWER_IDENTITY) => ({ reviewer: { prompt: { identity }, tools: { exclude: LEFT_OUT } } });

/** The model request that carried `prompt`. */
function requestFor(prompt: string): RecordedRequest {
  const found = world.fixture.requests.find((request) => JSON.stringify(request.messages).includes(prompt));
  if (!found) throw new Error(`no request carried ${prompt}`);
  return found;
}

const toolNames = (request: RecordedRequest) => ((request.body.tools ?? []) as { name: string }[]).map((tool) => tool.name);
const systemText = (request: RecordedRequest) => JSON.stringify(request.system ?? "");

/** The Agent of each open session, by the process that has it open. */
async function openAgents(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const { activeId } = await window.easyAgent.workspaces.get();
    const open = await window.easyAgent.agent.openSessions(activeId ?? "");
    return Object.fromEntries(open.map((s) => [s.sessionId, s.agent]));
  });
}

async function pickAgent(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /^Agent：/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("button", { name: `Agent：${name}` })).toBeVisible();
}

test.beforeEach(async () => {
  world = await createAgentWorld();
});

test.afterEach(async () => {
  await world.fixture.close();
});

test("without other Agents there is no Agent picker and sessions show no Agent", async () => {
  world.fixture.script([{ kind: "text", text: "只有默认 Agent。" }]);
  const { app, page } = await openProject(world);
  try {
    await expect(page.getByRole("button", { name: /^Agent：/ })).toHaveCount(0);
    await send(page, "默认的会话");
    await expect(page.getByText("只有默认 Agent。")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^default$/)).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("two sessions with different Agents run at the same time in separate processes", async () => {
  writeAgents(reviewer());
  world.fixture.script([
    // The default session's reply is held, so both turns run at once.
    { kind: "text", text: "默认 Agent 的回答。", delayMs: 6000 },
    { kind: "text", text: "审查 Agent 的回答。" },
  ]);
  const { app, page } = await openProject(world);
  try {
    await send(page, "用默认 Agent");
    await expect(page.getByRole("button", { name: "中断" })).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "新建会话" }).click();
    await pickAgent(page, "reviewer");
    await send(page, "用审查 Agent");
    await expect(page.getByText("审查 Agent 的回答。")).toBeVisible({ timeout: 30_000 });
    // The reviewer finished while the default session's turn still runs.
    expect(world.fixture.requests).toHaveLength(2);
    await expect(sessionRow(page, "用默认 Agent")).toBeVisible();

    const plain = requestFor("用默认 Agent");
    const reviewed = requestFor("用审查 Agent");
    for (const tool of LEFT_OUT) {
      expect(toolNames(plain)).toContain(tool);
      expect(toolNames(reviewed)).not.toContain(tool);
    }
    expect(toolNames(reviewed)).toContain("Read");
    expect(systemText(reviewed)).toContain(REVIEWER_IDENTITY);
    expect(systemText(plain)).not.toContain(REVIEWER_IDENTITY);

    const agents = Object.values(await openAgents(page)).sort();
    expect(agents).toEqual(["default", "reviewer"]);
    // Only the session that runs another Agent is labelled.
    await expect(page.locator("nav").getByText("reviewer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("会话创建后不能更换 Agent")).toHaveCount(0);

    await sessionRow(page, "用默认 Agent").click();
    await expect(page.getByText("默认 Agent 的回答。")).toBeVisible({ timeout: 20_000 });
  } finally {
    await app.close();
  }
});

test("a resumed session reopens with its Agent, and says so when that Agent changed or was deleted", async () => {
  writeAgents(reviewer());
  world.fixture.script([
    { kind: "text", text: "第一次审查。" },
    { kind: "text", text: "第二次审查。" },
    { kind: "text", text: "删掉以后。" },
  ]);
  const first = await openProject(world);
  await pickAgent(first.page, "reviewer");
  await send(first.page, "请审查");
  await expect(first.page.getByText("第一次审查。")).toBeVisible({ timeout: 20_000 });
  await first.app.close();

  // The reviewer's identity changes before the app starts again.
  writeAgents(reviewer("You are the stricter reviewer Agent."));
  const second = await launchApp({ userData: first.userData, env: world.env });
  try {
    await expect(second.page.getByText("第一次审查。")).toBeVisible({ timeout: 20_000 });
    await expect(second.page.getByText(/Agent「reviewer」的设置在这个会话上次运行后改过：prompt\.identity/)).toBeVisible();
    expect(Object.values(await openAgents(second.page))).toEqual(["reviewer"]);
    await second.page.getByRole("button", { name: "知道了" }).click();
    await expect(second.page.getByText(/上次运行后改过/)).toHaveCount(0);
    await send(second.page, "再审查一次");
    await expect(second.page.getByText("第二次审查。")).toBeVisible({ timeout: 20_000 });
    expect(systemText(requestFor("再审查一次"))).toContain("You are the stricter reviewer Agent.");
    expect(toolNames(requestFor("再审查一次"))).not.toContain("Bash");
  } finally {
    await second.app.close();
  }

  writeAgents({});
  const third = await launchApp({ userData: first.userData, env: world.env });
  try {
    await expect(third.page.getByText("第一次审查。")).toBeVisible({ timeout: 20_000 });
    await expect(third.page.getByText("这个会话原来用的 Agent「reviewer」已经删除，改用 default 继续")).toBeVisible();
    expect(Object.values(await openAgents(third.page))).toEqual(["default"]);
    await send(third.page, "删掉以后继续");
    await expect(third.page.getByText("删掉以后。")).toBeVisible({ timeout: 20_000 });
    expect(toolNames(requestFor("删掉以后继续"))).toContain("Bash");
  } finally {
    await third.app.close();
  }
});

test("a crashed Agent process restarts alone, and a reloaded window still knows each session's Agent", async () => {
  writeAgents(reviewer());
  world.fixture.script([
    { kind: "text", text: "默认会话的回答。" },
    { kind: "text", text: "崩溃前的审查。" },
    { kind: "text", text: "重启后的审查。" },
  ]);
  const { app, page } = await openProject(world);
  const rpcChildren = () => execSync(`pgrep -P ${app.process().pid} -f -- "--rpc" || true`).toString().split(/\s+/).filter(Boolean);
  try {
    await send(page, "默认会话");
    await expect(page.getByText("默认会话的回答。")).toBeVisible({ timeout: 20_000 });
    const [primary] = rpcChildren();
    await page.getByRole("button", { name: "新建会话" }).click();
    await pickAgent(page, "reviewer");
    await send(page, "审查会话");
    await expect(page.getByText("崩溃前的审查。")).toBeVisible({ timeout: 20_000 });
    const reviewerProcess = rpcChildren().find((pid) => pid !== primary);
    expect(reviewerProcess).toBeDefined();

    // Only the reviewer's process dies; its session shows the restart and continues with the reviewer.
    execSync(`kill -KILL ${reviewerProcess}`);
    await expect(page.getByText("Agent 进程退出了，正在重新启动。")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Agent 进程退出了，正在重新启动。")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByPlaceholder("继续对话")).toBeVisible({ timeout: 20_000 });
    expect(rpcChildren()).toContain(primary);
    await send(page, "重启后再审查");
    await expect(page.getByText("重启后的审查。")).toBeVisible({ timeout: 20_000 });
    expect(toolNames(requestFor("重启后再审查"))).not.toContain("Bash");

    await page.reload();
    await expect(page.getByText("重启后的审查。")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("nav").getByText("reviewer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("reviewer", { exact: true }).last()).toBeVisible();
    expect(Object.values(await openAgents(page)).sort()).toEqual(["default", "reviewer"]);
  } finally {
    await app.close();
  }
});

test("an Agent that does not resolve cannot be picked", async () => {
  writeAgents({ ...reviewer(), broken: { extends: "nowhere" } });
  const { app, page } = await openProject(world);
  try {
    await page.getByRole("button", { name: /^Agent：/ }).click();
    const broken = page.getByRole("menuitem", { name: /^broken/ });
    await expect(broken).toHaveAttribute("data-disabled", "");
    await expect(broken).toContainText("不可用");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Agent：default" })).toBeVisible();
  } finally {
    await app.close();
  }
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { launchApp } from "../helpers/app";

const clickMenuItem = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`no menu item ${itemId}`);
    item.click();
  }, id);

const readPrefs = (userData: string) => JSON.parse(readFileSync(join(userData, "preferences.json"), "utf8"));

test("the renderer has no Node access and only sees the preload API", async () => {
  const { app, page } = await launchApp();
  try {
    expect(await page.evaluate(() => [typeof (window as { require?: unknown }).require, typeof (window as { process?: unknown }).process])).toEqual([
      "undefined",
      "undefined",
    ]);
    expect(await page.evaluate(() => Object.keys(window.easyAgent).sort())).toEqual([
      "agent",
      "app",
      "menu",
      "pathOf",
      "platform",
      "prefs",
      "secrets",
      "workspaces",
    ]);

    const url = page.url();
    await page.evaluate(() => {
      location.href = "https://example.com/";
    });
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
  } finally {
    await app.close();
  }
});

test("the first-run shell offers to open a folder", async () => {
  const { app, page } = await launchApp({ prefs: { theme: "dark" } });
  try {
    await expect(page.getByRole("heading", { name: "欢迎使用 Easy Agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新建会话" }).first()).toBeDisabled();
    // Cancelling the folder dialog leaves the first-run page as it was.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    });
    await page.getByRole("button", { name: /^打开文件夹/ }).click();
    await expect(page.getByRole("heading", { name: "欢迎使用 Easy Agent" })).toBeVisible();
    await page.getByRole("button", { name: /^克隆仓库/ }).click();
    await expect(page.getByText("克隆仓库还没接入")).toBeVisible();
  } finally {
    await app.close();
  }
});

test("the View menu toggles the sidebar and the choice survives a restart", async () => {
  const first = await launchApp({ prefs: { theme: "dark" } });
  await expect(first.page.locator("aside")).toBeVisible();
  await clickMenuItem(first.app, "toggle-sidebar");
  await expect(first.page.locator("aside")).toHaveCount(0);
  await expect.poll(() => readPrefs(first.userData).sidebarOpen).toBe(false);
  await first.app.close();

  const second = await launchApp({ userData: first.userData });
  try {
    await expect(second.page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
    await expect(second.page.locator("aside")).toHaveCount(0);
  } finally {
    await second.app.close();
  }
});

test("theme and accent from the menu reach the page and the window", async () => {
  const { app, page, userData } = await launchApp({ prefs: { theme: "dark" } });
  try {
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await clickMenuItem(app, "theme-light");
    await expect(page.locator("html")).toHaveClass(/\blight\b/);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor())).toBe("#F4F4F2");

    await clickMenuItem(app, "accent-jade");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "jade");
    await expect.poll(() => readPrefs(userData)).toMatchObject({ theme: "light", accent: "jade" });
  } finally {
    await app.close();
  }
});

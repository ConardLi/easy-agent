import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { Prefs } from "../../src/shared/contract";

/** Window content size used by every screenshot, here and in the style reference. */
export const WINDOW = { width: 1280, height: 800 };

/** Screenshots are taken at 1x so they do not depend on the display. */
export const ELECTRON_FLAGS = ["--force-device-scale-factor=1"];

const APP_DIR = resolve(import.meta.dirname, "../..");

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
}

export function electronEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, ...extra };
}

export async function fitWindow(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), WINDOW);
  // CI displays can be smaller than the window, which then gets clamped; pin the viewport instead.
  await page.setViewportSize(WINDOW);
  await page.waitForFunction((size) => window.innerWidth === size.width && window.innerHeight === size.height, WINDOW);
  await page.evaluate(() => document.fonts.ready);
}

/** Start the built app (`npm run build`) with its own data directory and the given preferences. */
export async function launchApp(options: { prefs?: Partial<Prefs>; userData?: string } = {}): Promise<LaunchedApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), "easy-agent-desktop-"));
  if (options.prefs) writeFileSync(join(userData, "preferences.json"), JSON.stringify(options.prefs));
  const app = await electron.launch({ args: [...ELECTRON_FLAGS, APP_DIR], env: electronEnv({ EASY_AGENT_DESKTOP_USER_DATA: userData }) });
  const page = await app.firstWindow();
  await page.locator("aside, main").first().waitFor();
  await fitWindow(app, page);
  return { app, page, userData };
}

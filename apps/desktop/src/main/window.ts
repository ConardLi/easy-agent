import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";

const isMac = process.platform === "darwin";

/** `--bg` and `--fg` from the design tokens, so the window never flashes a different color. */
const CHROME = {
  dark: { background: "#0c0c0e", symbols: "#ececee" },
  light: { background: "#f4f4f2", symbols: "#17171a" },
};

/** Height of the sidebar header and the top bar. */
const TITLE_BAR_HEIGHT = 52;

function chrome() {
  return nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light;
}

export function applyWindowTheme(win: BrowserWindow): void {
  const { background, symbols } = chrome();
  win.setBackgroundColor(background);
  if (!isMac) win.setTitleBarOverlay({ color: background, symbolColor: symbols, height: TITLE_BAR_HEIGHT });
}

export function createMainWindow(): BrowserWindow {
  const { background, symbols } = chrome();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "Easy Agent",
    backgroundColor: background,
    titleBarStyle: "hidden",
    // The traffic lights sit where the sidebar header leaves room for them.
    ...(isMac ? { trafficLightPosition: { x: 20, y: 20 } } : { titleBarOverlay: { color: background, symbolColor: symbols, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // The window only ever shows the bundled renderer; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl && !app.isPackaged) void win.loadURL(devUrl);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return win;
}

// Opens the style reference in a window shaped like the client's, for baseline screenshots.
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");

// A fresh profile, so preferences the reference keeps in localStorage start from defaults.
app.setPath("userData", mkdtempSync(join(tmpdir(), "easy-agent-reference-")));

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 800, titleBarStyle: "hidden" });
  win.loadURL(process.env.REFERENCE_URL);
});

// Runs electron-vite without ELECTRON_RUN_AS_NODE. Terminals hosted by Electron
// apps can export it, and Electron then starts as plain Node and cannot load the app.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/electron-vite/bin/electron-vite.js", import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));

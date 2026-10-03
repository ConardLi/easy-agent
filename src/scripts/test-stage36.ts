/**
 * Release verification.
 *
 * Exercises the artifact users actually install: package metadata, product
 * documentation, bundle and source map contents, third-party notices, npm
 * file boundary, tarball contents, isolated installation, installed Headless
 * and interactive startup, command aliases, the installer, and the runtime
 * Node-version gate. No registry access or model credentials are required.
 *
 * Run: npm run test:stage36
 */

import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_FILE = path.join(PROJECT_ROOT, "dist", "eagent.js");
const DIST_MAP = `${DIST_FILE}.map`;
const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_LICENSES.txt";
const INSTALLER_FILE = path.join(PROJECT_ROOT, "install.sh");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const FIXTURE_MODEL = "release-fixture-model";
const FIXTURE_REPLY = "release fixture reply";

let passed = 0;
let failed = 0;

function section(title: string): void {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

function assert(condition: unknown, label: string, detail?: string): void {
  if (condition) {
    passed++;
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${label}\n`);
    return;
  }

  failed++;
  process.stdout.write(`  \u001b[31m✗ ${label}\u001b[0m${detail ? `\n    ${detail}` : ""}\n`);
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? PROJECT_ROOT,
    env: options.env ?? process.env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runAsync(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function parseNpmJson<T>(result: CommandResult, label: string): T | undefined {
  if (result.status !== 0) {
    assert(false, label, result.stderr || result.error?.message || `exit ${String(result.status)}`);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    assert(false, label, `invalid npm JSON: ${(error as Error).message}`);
    return undefined;
  }
}

interface PackResult {
  filename: string;
  files: Array<{ path: string; mode: number; size: number }>;
}

async function collectProductionSources(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "scripts") continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectProductionSources(absolute)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      files.push(absolute);
    }
  }

  return files;
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolute)));
    else files.push(absolute);
  }
  return files;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Slack token", /xox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const CREDENTIAL_NAME = /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

/** Credential values present on this machine; only their names are ever reported. */
async function localSecretValues(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const remember = (name: string, value: string | undefined) => {
    const trimmed = value?.trim().replace(/^["']|["']$/g, "");
    if (trimmed && trimmed.length >= 12) values.set(name, trimmed);
  };

  const dotenv = await fs.readFile(path.join(PROJECT_ROOT, ".env"), "utf8").catch(() => "");
  for (const line of dotenv.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) remember(`.env:${match[1]}`, match[2]);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (CREDENTIAL_NAME.test(name)) remember(`env:${name}`, value);
  }
  return values;
}

function isolatedCliEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  };
}

function sse(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

async function startFixtureProvider(): Promise<{ baseURL: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      count++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          sse("message_start", {
            type: "message_start",
            message: {
              id: "msg_release",
              type: "message",
              role: "assistant",
              model: FIXTURE_MODEL,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          }),
          sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
          sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: FIXTURE_REPLY } }),
          sse("content_block_stop", { type: "content_block_stop", index: 0 }),
          sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
          sse("message_stop", { type: "message_stop" }),
        ].join(""),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const PTY_HELPER = "import pty, sys\nstatus = pty.spawn(sys.argv[1:])\nsys.exit(status >> 8 if status & 0xff == 0 else 1)\n";

/** Starts the installed CLI in a real pseudo-terminal, accepts the trust prompt, and exits with Ctrl+D. */
async function runInteractiveStartup(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ trustPrompt: boolean; banner: boolean; exitCode: number | null; screen: string }> {
  const child = spawn("python3", ["-c", PTY_HELPER, command], {
    cwd,
    env: { ...env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const screen = () => output.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "");
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  const waitFor = async (text: string, timeoutMs = 15_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (screen().includes(text)) return true;
      if (child.exitCode !== null) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };

  const trustPrompt = await waitFor("Do you trust the files in this folder?");
  if (trustPrompt) child.stdin.write("\r");
  const banner = trustPrompt && (await waitFor("Type a message to start")) && (await waitFor("? for shortcuts"));
  // Ink attaches its input handler after the first frame; resend Ctrl+D until
  // the REPL exits so a slow first render does not swallow the keystroke.
  const exitKeys = banner ? setInterval(() => child.stdin.write("\u0004"), 500) : undefined;
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const exitCode = await closed;
  clearTimeout(timeout);
  clearInterval(exitKeys);
  return { trustPrompt, banner, exitCode, screen: screen().slice(-2_000) };
}

const packageJson = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf-8")) as {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  license?: string;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
};

const ROADMAP_WORDING = /\b(?:[Ss]tage|[Pp]hase)\s+\d|阶段\s*\d|\brebuil[dt]\b|from scratch|\b[Cc]lone\b|\b[Tt]utorials?\b|\b[Tt]eaching\b|复刻|教学|教程/;

section("[1] package contract");
assert(packageJson.name === "eagent", "package name is eagent");
assert(
  JSON.stringify(packageJson.bin) ===
    JSON.stringify({ eagent: "dist/eagent.js", "easy-agent": "dist/eagent.js" }),
  "only eagent and easy-agent are registered",
);
assert(
  JSON.stringify(packageJson.dependencies ?? {}) ===
    JSON.stringify({ "@anthropic-ai/sandbox-runtime": "0.0.76" }),
  "runtime dependencies are explicit and version-pinned",
);
assert(packageJson.engines?.node === ">=22", "Node engine is >=22");
assert(packageJson.license === "MIT", "package license is MIT");
assert(Boolean(packageJson.repository), "repository metadata exists");
assert(Boolean(packageJson.homepage), "homepage metadata exists");
assert(Boolean(packageJson.bugs), "bugs metadata exists");
assert(
  Boolean(packageJson.description) && !ROADMAP_WORDING.test(packageJson.description ?? ""),
  "npm description describes the product, not how it was built",
  packageJson.description,
);
assert(
  (packageJson.keywords ?? []).length >= 5 && !(packageJson.keywords ?? []).some((keyword) => ROADMAP_WORDING.test(keyword)),
  "npm keywords describe product capabilities",
  (packageJson.keywords ?? []).join(", "),
);

section("[2] product documentation");
for (const readme of ["README.md", "README.zh-CN.md"]) {
  const text = await fs.readFile(path.join(PROJECT_ROOT, readme), "utf8");
  const roadmapLines = text.split("\n").filter((line) => /\b[Ss]tage\s+\d|阶段\s*\d|step\/step\d/.test(line));
  assert(roadmapLines.length === 0, `${readme} carries no roadmap stage progress`, roadmapLines.join(" | "));
  assert(text.includes("docs/learning-path.md"), `${readme} links the learning path document`);

  const brokenLinks: string[] = [];
  for (const match of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const target = match[1]!.split("#")[0]!;
    if (target && !(await fs.access(path.join(PROJECT_ROOT, target)).then(() => true, () => false))) {
      brokenLinks.push(target);
    }
  }
  assert(brokenLinks.length === 0, `${readme} relative links resolve`, brokenLinks.join(", "));
}

section("[3] bundle contract");
const [bundle, bundleStat, mapText] = await Promise.all([
  fs.readFile(DIST_FILE, "utf-8"),
  fs.stat(DIST_FILE),
  fs.readFile(DIST_MAP, "utf-8"),
]);
const sourceMap = JSON.parse(mapText) as { sources: string[]; sourcesContent?: unknown };
assert(bundle.startsWith("#!/usr/bin/env node\n"), "bundle starts with a Node shebang");
assert((bundleStat.mode & constants.S_IXUSR) !== 0, "bundle is executable");
assert(bundleStat.size > 0, "bundle is non-empty");
assert(sourceMap.sources.length > 0, "source map lists bundled sources");
assert(sourceMap.sourcesContent === undefined, "source map does not embed source text");
assert(
  sourceMap.sources.every(
    (source) => !path.isAbsolute(source) && !/^(?:[A-Za-z]:[\\/]|file:)/.test(source) && !source.startsWith("../../"),
  ),
  "source map paths stay relative to the package",
  sourceMap.sources.filter((source) => path.isAbsolute(source) || source.startsWith("../../")).slice(0, 5).join(", "),
);
assert(
  !sourceMap.sources.some((source) => source.startsWith("../src/scripts/")),
  "test and smoke scripts are not bundled",
);

const bundleHygiene = run(process.execPath, ["--import", "tsx", "scripts/check-source-hygiene.ts", "--bundle", "dist/eagent.js"]);
assert(
  bundleHygiene.status === 0,
  "bundled application code carries no roadmap, reference, or tutorial markers",
  (bundleHygiene.stdout + bundleHygiene.stderr).trim().split("\n").slice(-12).join("\n    "),
);
const buildPaths = [PROJECT_ROOT, os.homedir()].filter((value) => value.length > 1);
for (const [label, text] of [["bundle", bundle], ["source map", mapText]] as const) {
  assert(!buildPaths.some((value) => text.includes(value)), `${label} contains no absolute build-machine paths`);
}

const versionResult = run(process.execPath, [DIST_FILE, "--version"]);
assert(versionResult.status === 0, "built --version exits successfully", versionResult.stderr);
assert(versionResult.stdout.trim() === `eagent ${packageJson.version}`, "built --version matches package.json");

const helpResult = run(process.execPath, [DIST_FILE, "--help"]);
assert(helpResult.status === 0, "built --help exits successfully", helpResult.stderr);
assert(helpResult.stdout.includes("eagent [options]"), "help documents the eagent command");
assert(!helpResult.stdout.includes("\n  agent [options]"), "help does not advertise the retired agent command");

const productionSources = await collectProductionSources(path.join(PROJECT_ROOT, "src"));
const hardcodedVersionFiles: string[] = [];
for (const source of productionSources) {
  if ((await fs.readFile(source, "utf-8")).includes(`\"${packageJson.version}\"`)) {
    hardcodedVersionFiles.push(path.relative(PROJECT_ROOT, source));
  }
}
assert(
  hardcodedVersionFiles.length === 0,
  "release version is not hard-coded in production source",
  hardcodedVersionFiles.join(", "),
);

section("[4] third-party licenses");
const noticesCheck = run(process.execPath, ["--import", "tsx", "scripts/third-party-notices.ts", "--check"]);
assert(
  noticesCheck.status === 0,
  `${THIRD_PARTY_NOTICES_FILE} covers every bundled package with a permitted license`,
  (noticesCheck.stdout + noticesCheck.stderr).trim(),
);
process.stdout.write(`    ${noticesCheck.stdout.trim()}\n`);

section("[5] npm package boundary");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eagent-release-"));
const cacheDir = path.join(tempRoot, "npm-cache");
const packDir = path.join(tempRoot, "pack");
const extractDir = path.join(tempRoot, "extract");
const installPrefix = path.join(tempRoot, "prefix");
const cliHome = path.join(tempRoot, "home");
const cliProject = path.join(tempRoot, "project");
await Promise.all(
  [cacheDir, packDir, extractDir, installPrefix, cliHome, cliProject].map((dir) => fs.mkdir(dir, { recursive: true })),
);

try {
  const npmEnv: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: cacheDir };
  // `npm publish --dry-run` exports its config into lifecycle scripts. If that
  // flag leaks into the nested install below, npm reports success without
  // creating the prefix and this verification tests nothing. Each nested npm
  // command declares its own dry-run behavior explicitly, so remove the outer
  // lifecycle setting here.
  delete npmEnv.npm_config_dry_run;
  delete npmEnv.NPM_CONFIG_DRY_RUN;
  const dryRun = parseNpmJson<PackResult[]>(
    run(NPM, ["pack", "--dry-run", "--json", "--ignore-scripts"], { env: npmEnv }),
    "npm pack --dry-run succeeds",
  );

  const expectedFiles = [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    `dist/${THIRD_PARTY_NOTICES_FILE}`,
    "dist/eagent.js",
    "dist/eagent.js.map",
    "package.json",
  ];
  const packedFiles = dryRun?.[0]?.files.map((file) => file.path).sort() ?? [];
  assert(JSON.stringify(packedFiles) === JSON.stringify(expectedFiles), "tarball contains only release files", packedFiles.join(", "));

  const pack = parseNpmJson<PackResult[]>(
    run(NPM, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { env: npmEnv }),
    "npm pack succeeds",
  );
  const tarball = pack?.[0]?.filename ? path.join(packDir, pack[0].filename) : undefined;
  assert(Boolean(tarball), "npm reports the generated tarball");

  if (tarball) {
    const extract = run("tar", ["-xzf", tarball, "-C", extractDir]);
    assert(extract.status === 0, "tarball extracts", extract.stderr);
    const packageRoot = path.join(extractDir, "package");
    const extracted = (await collectFiles(packageRoot)).map((file) => path.relative(packageRoot, file).split(path.sep).join("/"));
    const forbidden = extracted.filter((file) =>
      /(?:^|\/)\.env(?:\.|$)|\.jsonl$|\.log$|\.err$|\.tgz$|^(?:src|step|scripts|docs|node_modules)\/|(?:^|\/)\.(?:easy-agent|claude|git)\//.test(file),
    );
    assert(forbidden.length === 0, "tarball has no env files, sessions, logs, or source trees", forbidden.join(", "));

    const secretValues = await localSecretValues();
    const patternHits: string[] = [];
    const valueHits = new Set<string>();
    for (const file of extracted) {
      const text = await fs.readFile(path.join(packageRoot, file), "utf8");
      for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(text)) patternHits.push(`${file}: ${label}`);
      for (const [name, value] of secretValues) if (text.includes(value)) valueHits.add(`${file}: ${name}`);
    }
    assert(patternHits.length === 0, "tarball contains no token-shaped strings", patternHits.join(", "));
    assert(
      valueHits.size === 0,
      `tarball contains none of ${secretValues.size} local credential value(s)`,
      [...valueHits].join(", "),
    );

    const install = run(
      NPM,
      ["install", "-g", "--ignore-scripts", "--prefix", installPrefix, tarball],
      { env: npmEnv },
    );
    assert(install.status === 0, "tarball installs in an isolated global prefix", install.stderr);

    const binDir = path.join(installPrefix, process.platform === "win32" ? "" : "bin");
    const commandSuffix = process.platform === "win32" ? ".cmd" : "";
    const eagentBin = path.join(binDir, `eagent${commandSuffix}`);
    const longBin = path.join(binDir, `easy-agent${commandSuffix}`);
    const retiredBin = path.join(binDir, `agent${commandSuffix}`);

    const [eagentExists, longExists, retiredExists] = await Promise.all([
      fs.access(eagentBin).then(() => true, () => false),
      fs.access(longBin).then(() => true, () => false),
      fs.access(retiredBin).then(() => true, () => false),
    ]);
    assert(eagentExists, "installed eagent command exists");
    assert(longExists, "installed easy-agent command exists");
    assert(!retiredExists, "retired agent command is absent");

    const installedPackage = path.join(installPrefix, "lib", "node_modules", "eagent");
    const sandboxRuntimePackage = path.join(installedPackage, "node_modules", "@anthropic-ai", "sandbox-runtime", "package.json");
    const sandboxRuntimeInstalled = await fs.access(sandboxRuntimePackage).then(() => true, () => false);
    assert(sandboxRuntimeInstalled, "installed package includes the sandbox runtime dependency");

    section("[6] installed CLI");
    const cliEnv = isolatedCliEnv(cliHome);
    for (const [name, bin] of [["eagent", eagentBin], ["easy-agent", longBin]] as const) {
      const version = run(bin, ["--version"], { cwd: cliProject, env: cliEnv });
      assert(version.stdout.trim() === `eagent ${packageJson.version}`, `installed ${name} reports the release version`, version.stderr);
      const help = run(bin, ["--help"], { cwd: cliProject, env: cliEnv });
      assert(help.status === 0 && help.stdout.includes("eagent [options]"), `installed ${name} prints help`, help.stderr);
    }

    const provider = await startFixtureProvider();
    try {
      const providerEnv = isolatedCliEnv(cliHome, {
        ANTHROPIC_AUTH_TOKEN: "release-fixture-token",
        ANTHROPIC_BASE_URL: provider.baseURL,
        ANTHROPIC_MODEL: FIXTURE_MODEL,
      });

      const text = await runAsync(eagentBin, ["-p", "Say hello."], { cwd: cliProject, env: providerEnv });
      assert(text.status === 0 && text.stdout === `${FIXTURE_REPLY}\n`, "installed Headless text mode answers", text.stderr || text.stdout);

      const json = await runAsync(eagentBin, ["-p", "Say hello.", "--output-format", "json"], { cwd: cliProject, env: providerEnv });
      let result: Record<string, unknown> | undefined;
      try {
        result = JSON.parse(json.stdout) as Record<string, unknown>;
      } catch {
        result = undefined;
      }
      assert(
        json.status === 0 && result?.type === "result" && result.schema_version === 1 && result.result === FIXTURE_REPLY && result.is_error === false,
        "installed Headless JSON mode returns a versioned result",
        json.stderr || json.stdout,
      );
      assert(provider.requests() === 2, "Headless runs reach only the configured provider endpoint", `requests=${provider.requests()}`);

      if (process.platform === "win32") {
        process.stdout.write("    interactive startup skipped: no pseudo-terminal helper on Windows\n");
      } else {
        const interactive = await runInteractiveStartup(eagentBin, cliProject, providerEnv);
        assert(interactive.trustPrompt, "interactive startup asks for workspace trust", interactive.screen);
        assert(interactive.banner, "interactive startup renders the REPL after trust", interactive.screen);
        assert(interactive.exitCode === 0, "interactive session exits cleanly on Ctrl+D", `exit=${String(interactive.exitCode)}`);
      }
    } finally {
      await provider.close();
    }

    const cliData = (await collectFiles(cliHome).catch(() => [])).map((file) => path.relative(cliHome, file));
    assert(
      !cliData.some((file) => /stream-debug\.log/.test(file)),
      "installed CLI writes no debug log unless enabled",
      cliData.join(", "),
    );
  }

  section("[7] installer contract");
  const fakeBin = path.join(tempRoot, "fake-bin");
  const npmLog = path.join(tempRoot, "npm.log");
  const fakePrefix = path.join(tempRoot, "npm-prefix");
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeNode = path.join(fakeBin, "node");
  const fakeNpm = path.join(fakeBin, "npm");
  const fakeEagent = path.join(fakeBin, "eagent");
  await Promise.all([
    fs.writeFile(fakeNode, '#!/bin/sh\nprintf "22.22.0\\n"\n', { mode: 0o755 }),
    fs.writeFile(
      fakeNpm,
      `#!/bin/sh\nif [ "$1" = "prefix" ]; then printf '%s\\n' ${JSON.stringify(fakePrefix)}; exit 0; fi\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}\n`,
      { mode: 0o755 },
    ),
    fs.writeFile(fakeEagent, `#!/bin/sh\nprintf 'eagent ${packageJson.version}\\n'\n`, { mode: 0o755 }),
  ]);

  const installerEnv = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    EAGENT_VERSION: "next",
  };
  const installerFirst = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
  const installerSecond = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
  assert(installerFirst.status === 0, "installer succeeds with Node 22", installerFirst.stderr);
  assert(installerSecond.status === 0, "installer is idempotent", installerSecond.stderr);
  const npmCalls = (await fs.readFile(npmLog, "utf-8")).trim().split("\n");
  assert(npmCalls.length === 2, "idempotent install invokes npm once per run");
  assert(
    npmCalls.every((call) => call === "install -g --ignore-scripts eagent@next"),
    "installer honors EAGENT_VERSION and disables lifecycle scripts",
    npmCalls.join(" | "),
  );

  await fs.writeFile(fakeNode, '#!/bin/sh\nprintf "20.19.0\\n"\n', { mode: 0o755 });
  const oldInstaller = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
  assert(oldInstaller.status === 1, "installer rejects Node 20");
  assert(oldInstaller.stderr.includes("Node.js 22 or newer"), "installer explains the Node requirement");

  await fs.writeFile(fakeNode, '#!/bin/sh\nprintf "22.22.0\\n"\n', { mode: 0o755 });
  await fs.rm(fakeEagent);
  const missingPath = run("/bin/sh", [INSTALLER_FILE], { env: installerEnv });
  assert(missingPath.status === 1, "installer fails when the command is not on PATH");
  assert(
    missingPath.stderr.includes(`${fakePrefix}/bin`),
    "installer reports the npm global bin directory",
    missingPath.stderr,
  );

  section("[8] old-Node failure path");
  const simulatedOldNode = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `Object.defineProperty(process.versions, "node", { value: "18.20.0" }); await import(${JSON.stringify(pathToFileURL(DIST_FILE).href)});`,
  ]);
  assert(simulatedOldNode.status === 1, "Node 18 path exits non-zero");
  assert(simulatedOldNode.stderr.includes("requires Node.js 22 or newer"), "Node 18 path prints an actionable message");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`\n\u001b[1mRelease verification: ${passed} passed, ${failed} failed.\u001b[0m\n`);
if (failed > 0) process.exitCode = 1;

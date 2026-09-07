import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type TestGroup = "core" | "extensions" | "ui" | "platform" | "live";

interface TestDefinition {
  id: string;
  group: TestGroup;
  file: string;
  args?: string[];
  platforms?: NodeJS.Platform[];
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_GROUPS: TestGroup[] = ["core", "extensions", "ui"];
const ALL_GROUPS: TestGroup[] = ["core", "extensions", "ui", "platform", "live"];
const TEST_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 1_000_000;

const TESTS: TestDefinition[] = [
  { id: "cli-headless", group: "core", file: "src/scripts/test-cli-headless-characterization.ts" },
  { id: "config-session", group: "core", file: "src/scripts/test-config-session-characterization.ts" },
  { id: "query-engine", group: "core", file: "src/scripts/test-queryengine-characterization.ts" },
  { id: "provider-stream", group: "core", file: "src/scripts/test-providerstream-characterization.ts" },
  { id: "session-notices", group: "core", file: "src/scripts/test-useagentsession-notices.ts" },
  { id: "tools", group: "core", file: "src/scripts/test-tools.ts" },
  { id: "path-boundary", group: "core", file: "src/scripts/test-path-boundary.ts" },
  { id: "bash-readonly", group: "core", file: "src/scripts/test-bash-readonly.ts" },
  { id: "tasks", group: "core", file: "src/scripts/test-tasks.ts" },
  { id: "tool-search", group: "core", file: "src/scripts/test-toolsearch.ts" },
  { id: "tool-search-integration", group: "core", file: "src/scripts/test-toolsearch-integration.ts" },
  { id: "mcp", group: "core", file: "src/scripts/test-mcp.ts" },
  { id: "skills", group: "core", file: "src/scripts/test-skills.ts" },
  { id: "sandbox-unit", group: "core", file: "src/scripts/test-sandbox.ts" },
  { id: "agents", group: "core", file: "src/scripts/test-agents.ts" },
  { id: "permission-regression", group: "core", file: "scripts/verify-permission-regression.ts" },
  { id: "auto-mode-config", group: "core", file: "scripts/verify-auto-mode-stage4.ts" },

  { id: "background-worktree", group: "extensions", file: "src/scripts/test-stage20.ts" },
  { id: "agent-teams", group: "extensions", file: "src/scripts/test-stage21.ts" },
  { id: "hooks", group: "extensions", file: "src/scripts/test-stage22.ts" },
  { id: "styles-commands", group: "extensions", file: "src/scripts/test-stage23.ts" },
  { id: "configuration", group: "extensions", file: "src/scripts/smoke-config.ts" },
  { id: "providers", group: "extensions", file: "scripts/verify-multi-protocol.ts" },
  { id: "extended-tools", group: "extensions", file: "src/scripts/test-stage31.ts" },
  { id: "multimodal", group: "extensions", file: "src/scripts/test-stage32.ts" },
  { id: "built-in-commands", group: "extensions", file: "src/scripts/test-stage33.ts" },
  { id: "plugins", group: "extensions", file: "src/scripts/test-stage35.ts" },
  { id: "file-history", group: "extensions", file: "src/scripts/smoke-filehistory.ts" },
  { id: "resilience", group: "extensions", file: "src/scripts/smoke-resilience.ts" },

  { id: "rendering", group: "ui", file: "src/scripts/smoke-stage24.tsx" },
  { id: "markdown", group: "ui", file: "src/scripts/smoke-markdown.tsx" },
  { id: "clear", group: "ui", file: "src/scripts/smoke-static-clear.tsx" },
  { id: "ui", group: "ui", file: "src/scripts/smoke-ui.tsx" },
  { id: "question", group: "ui", file: "src/scripts/smoke-question.tsx" },
  { id: "transcript", group: "ui", file: "src/scripts/smoke-transcript.tsx" },
  { id: "permission", group: "ui", file: "src/scripts/smoke-permission.tsx" },
  { id: "bash-stream", group: "ui", file: "src/scripts/smoke-bash-stream.ts" },
  { id: "input", group: "ui", file: "src/scripts/smoke-input.tsx" },
  { id: "group", group: "ui", file: "src/scripts/smoke-group.tsx" },
  { id: "bash-output", group: "ui", file: "src/scripts/smoke-bash-output.tsx" },
  { id: "condensed", group: "ui", file: "src/scripts/smoke-condensed.tsx" },
  { id: "tool-states", group: "ui", file: "src/scripts/smoke-tool-states.tsx" },
  { id: "bash-progress", group: "ui", file: "src/scripts/smoke-bash-progress.tsx" },
  { id: "bash-heartbeat", group: "ui", file: "src/scripts/smoke-bash-heartbeat.tsx" },
  { id: "live-group", group: "ui", file: "src/scripts/smoke-live-group.tsx" },
  { id: "tool-tags", group: "ui", file: "src/scripts/smoke-tool-tags.tsx" },
  { id: "tool-card-format", group: "ui", file: "src/scripts/test-tool-card-format.ts" },
  { id: "transcript-wheel", group: "ui", file: "src/scripts/smoke-transcript-wheel.tsx" },
  { id: "status-line", group: "ui", file: "src/scripts/smoke-statusline.tsx" },
  { id: "command", group: "ui", file: "src/scripts/smoke-command.tsx" },
  { id: "plugin-manager", group: "ui", file: "src/scripts/test-stage35-ui.tsx" },

  { id: "sandbox-host", group: "platform", file: "src/scripts/smoke-sandbox.ts", platforms: ["darwin"] },
  { id: "bash-sandbox-host", group: "platform", file: "src/scripts/smoke-bash-sandbox.ts", platforms: ["darwin"] },

  { id: "anthropic-stream", group: "live", file: "src/scripts/test-streaming.ts" },
  { id: "tool-search-live", group: "live", file: "src/scripts/test-toolsearch-live.ts" },
  { id: "auto-classifier-live", group: "live", file: "scripts/verify-auto-classifier.ts" },
  { id: "auto-mode-live", group: "live", file: "scripts/verify-auto-mode.ts" },
  { id: "auto-mode-recovery-live", group: "live", file: "scripts/verify-auto-mode-stage3.ts" },
];

interface CliOptions {
  groups: TestGroup[];
  list: boolean;
  keepTemp: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const groups: TestGroup[] = [];
  let list = false;
  let keepTemp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--keep-temp") {
      keepTemp = true;
      continue;
    }
    if (arg === "--group") {
      const value = argv[++index] as TestGroup | undefined;
      if (!value || !ALL_GROUPS.includes(value)) {
        throw new Error(`Invalid --group value: ${value ?? "(missing)"}. Expected one of: ${ALL_GROUPS.join(", ")}`);
      }
      if (!groups.includes(value)) groups.push(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { groups: groups.length > 0 ? groups : DEFAULT_GROUPS, list, keepTemp };
}

function isolatedEnvironment(home: string, live: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (!live) {
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (
        /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/.test(upper) ||
        ["ANTHROPIC_", "OPENAI_", "GEMINI_", "GOOGLE_", "EASY_AGENT_", "WEB_SEARCH_", "MCP_"].some(
          (prefix) => upper.startsWith(prefix),
        ) ||
        ["EDITOR", "VISUAL", "NODE_OPTIONS", "NODE_PATH", "LIVE"].includes(upper)
      ) {
        delete env[key];
      }
    }

    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_DATA_HOME = path.join(home, ".local", "share");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    env.APPDATA = path.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }

  env.CI = "1";
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.EASY_AGENT_ENABLE_STREAM_DEBUG = "0";
  if (!live) env.LIVE = "0";
  return env;
}

function appendCapture(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) return next;
  return `[output truncated to last ${MAX_CAPTURE_BYTES} bytes]\n${Buffer.from(next).subarray(-MAX_CAPTURE_BYTES).toString("utf8")}`;
}

interface TestResult {
  definition: TestDefinition;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
}

async function runTest(definition: TestDefinition, runRoot: string): Promise<TestResult> {
  const home = path.join(runRoot, definition.id);
  await mkdir(home, { recursive: true });
  const startedAt = Date.now();
  const live = definition.group === "live";

  return new Promise<TestResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(PROJECT_ROOT, definition.file), ...(definition.args ?? [])],
      {
        cwd: PROJECT_ROOT,
        env: isolatedEnvironment(home, live),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, TEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendCapture(output, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        definition,
        durationMs: Date.now() - startedAt,
        exitCode,
        signal,
        output,
        timedOut,
      });
    });
  });
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = TESTS.filter((test) => options.groups.includes(test.group));

  if (options.list) {
    for (const test of selected) {
      const platforms = test.platforms ? ` [${test.platforms.join(",")}]` : "";
      process.stdout.write(`${test.group}\t${test.id}\t${test.file}${platforms}\n`);
    }
    return;
  }

  const runRoot = await mkdtemp(path.join(tmpdir(), "eap-"));
  const failures: TestResult[] = [];
  let passed = 0;
  let skipped = 0;
  const startedAt = Date.now();

  process.stdout.write(`Production verification: ${selected.length} test(s), groups=${options.groups.join(",")}\n`);

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const test = selected[index]!;
      const prefix = `[${index + 1}/${selected.length}]`;
      if (test.platforms && !test.platforms.includes(process.platform)) {
        skipped += 1;
        process.stdout.write(`${prefix} SKIP ${test.id} (requires ${test.platforms.join(" or ")})\n`);
        continue;
      }

      process.stdout.write(`${prefix} RUN  ${test.id}\n`);
      const result = await runTest(test, runRoot);
      if (result.exitCode === 0 && !result.timedOut) {
        passed += 1;
        process.stdout.write(`${prefix} PASS ${test.id} (${formatDuration(result.durationMs)})\n`);
      } else {
        failures.push(result);
        const outcome = result.timedOut
          ? `timed out after ${formatDuration(TEST_TIMEOUT_MS)}`
          : `exit=${String(result.exitCode)} signal=${result.signal ?? "none"}`;
        process.stdout.write(`${prefix} FAIL ${test.id} (${outcome})\n${result.output.trimEnd()}\n`);
      }
    }
  } finally {
    if (options.keepTemp) {
      process.stdout.write(`Temporary test data kept at ${runRoot}\n`);
    } else {
      await rm(runRoot, { recursive: true, force: true });
    }
  }

  process.stdout.write(
    `Production verification finished in ${formatDuration(Date.now() - startedAt)}: ` +
      `${passed} passed, ${skipped} skipped, ${failures.length} failed.\n`,
  );

  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

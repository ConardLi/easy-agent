/**
 * Headless `--harness`: the Agent a `-p` run uses and the `harness` field of
 * its `result` message.
 *
 *   - without `--harness` the result names `default`;
 *   - `--harness <name>` and `--harness <file>` run that Agent (its model and
 *     tools reach the request) and the result carries its name and the hash
 *     `eagent harness show` reports for it;
 *   - a spec file works on a machine without user settings, as in CI;
 *   - the same spec gives the same hash, a changed one another;
 *   - a missing file or an unknown name exits 1 with the reason on stderr,
 *     prints nothing on stdout, and sends no request.
 *
 * No model key is available here, so the endpoint rejects every request
 * (401) and records what it received; the result is then an error result,
 * which carries `harness` too. `scripts/verify-headless-harness-live.ts`
 * checks successful runs against real models.
 *
 * Run: node --import tsx src/scripts/test-headless-harness.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Ajv } from "ajv";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "entrypoint", "cli.ts");
const TSX_IMPORT = import.meta.resolve("tsx");

const validateOutput = new Ajv({ strictRequired: false, allowUnionTypes: true }).compile(
  JSON.parse(await readFile(path.join(PROJECT_ROOT, "docs", "headless-output.schema.json"), "utf8")),
);

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easy-agent-headless-harness-")));
const home = path.join(root, "home");
const emptyHome = path.join(root, "ci-home");
const cwd = path.join(root, "project");
await Promise.all(
  [path.join(home, ".easy-agent"), emptyHome, path.join(cwd, "ci")].map((dir) => mkdir(dir, { recursive: true })),
);
await writeFile(
  path.join(home, ".easy-agent", "settings.json"),
  JSON.stringify({
    harnesses: { reviewer: { model: { main: "review-model" }, tools: { exclude: ["WebFetch", "WebSearch"] } } },
  }),
);
const specFile = path.join(cwd, "ci", "agent.json");
await writeFile(specFile, JSON.stringify({ model: { main: "file-model" }, tools: { exclude: ["Bash"] } }));

interface Received {
  model: unknown;
  tools: string[];
}
const received: Received[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      model?: unknown;
      tools?: { name: string }[];
    };
    received.push({ model: body.model, tools: (body.tools ?? []).map((tool) => tool.name) });
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no key here" } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function runCli(args: string[], homeDir = home): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_IMPORT, CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ANTHROPIC_AUTH_TOKEN: "no-key",
        ANTHROPIC_BASE_URL: baseURL,
        ANTHROPIC_MODEL: "env-model",
        EASY_AGENT_DISABLE_HOOKS: "1",
        EASY_AGENT_ENABLE_TOOL_SEARCH: "false",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

type Line = Record<string, unknown>;

/** The `harness` field of a result line. */
function harnessOf(line: Line | undefined): { name: string; hash: string } {
  assert.equal(line?.type, "result");
  const harness = line.harness as { name: string; hash: string } | undefined;
  assert.ok(harness, "the result carries harness");
  return harness;
}

/** Run `-p` and return its output lines, each checked against the schema. */
async function headless(args: string[], homeDir = home): Promise<Line[]> {
  const run = await runCli(["-p", "Review the change", ...args], homeDir);
  assert.equal(run.code, 1, `the endpoint rejects the request, so the run fails: ${run.stderr}`);
  const lines = run.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Line);
  for (const line of lines) assert.ok(validateOutput(line), JSON.stringify(validateOutput.errors));
  return lines;
}

/** The name and hash `eagent harness show [target] --json` reports. */
async function shown(target: string[], homeDir = home): Promise<{ name: string; hash: string }> {
  const run = await runCli(["harness", "show", ...target, "--json"], homeDir);
  assert.equal(run.code, 0, run.stderr);
  const { name, hash } = (JSON.parse(run.stdout) as { harness: { name: string; hash: string } }).harness;
  return { name, hash };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  await check("without --harness the result names default and its hash", async () => {
    const [result] = await headless(["--output-format", "json"]);
    assert.equal(result?.type, "result");
    assert.equal(result?.subtype, "error_during_execution");
    assert.deepEqual(harnessOf(result), await shown([]));
    assert.equal(harnessOf(result).name, "default");
    assert.equal(received.at(-1)?.model, "env-model");
  });

  await check("--harness <name> runs that Agent and the result names it", async () => {
    const [result] = await headless(["--harness", "reviewer", "--output-format", "json"]);
    assert.deepEqual(harnessOf(result), { name: "reviewer", hash: (await shown(["reviewer"])).hash });
    assert.notEqual(harnessOf(result).hash, (await shown([])).hash);
    const request = received.at(-1)!;
    assert.equal(request.model, "review-model");
    assert.ok(request.tools.includes("Read"));
    assert.ok(!request.tools.includes("WebFetch") && !request.tools.includes("WebSearch"), request.tools.join());
  });

  await check("--harness <file> runs the spec without user settings, as in CI", async () => {
    const before = received.length;
    const lines = await headless(["--harness", "./ci/agent.json", "--output-format", "stream-json"], emptyHome);
    const init = lines[0]!;
    const result = lines.at(-1)!;
    assert.equal(init.subtype, "init");
    assert.ok(!(init.tools as string[]).includes("Bash"), "the spec's tools reach system/init");
    assert.deepEqual(harnessOf(result), await shown(["./ci/agent.json"], emptyHome));
    assert.equal(harnessOf(result).name, "(inline)");
    assert.equal(received.length, before + 1);
    assert.equal(received.at(-1)?.model, "file-model");
    assert.ok(!received.at(-1)!.tools.includes("Bash"));
  });

  await check("the same spec gives the same hash; a changed spec another", async () => {
    const hashOf = async () =>
      harnessOf((await headless(["--harness", specFile, "--output-format", "json"], emptyHome))[0]).hash;
    const first = await hashOf();
    assert.equal(await hashOf(), first);
    await writeFile(specFile, JSON.stringify({ model: { main: "other-model" }, tools: { exclude: ["Bash"] } }));
    const changed = await hashOf();
    assert.notEqual(changed, first);
    assert.equal(changed, (await shown([specFile], emptyHome)).hash);
  });

  await check("a missing file or an unknown name exits 1 with nothing on stdout and no request", async () => {
    const before = received.length;
    for (const [args, reason] of [
      [["--harness", "./ci/missing.json"], /--harness: cannot read .*missing\.json/],
      [["--harness", "ghost"], /no Agent named "ghost"/],
    ] as const) {
      for (const format of ["json", "stream-json"]) {
        const run = await runCli(["-p", "Review the change", ...args, "--output-format", format]);
        assert.equal(run.code, 1, `${args.join(" ")} ${format}`);
        assert.match(run.stderr, reason);
        assert.equal(run.stdout, "", "a startup failure prints no result message");
      }
    }
    assert.equal(received.length, before, "a failed selection sends nothing to the model");
  });
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log(`\nHeadless --harness: ${passed} passed, 0 failed.`);

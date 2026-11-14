/**
 * Live check of Headless `--harness` against real providers (needs real
 * model profiles and keys in the workspace settings; not part of
 * verify:production).
 *
 * Runs the built CLI (`dist/eagent.js`, run `npm run build` first) in the
 * current workspace, trusting its settings for the run. For each model
 * handle given:
 *   - `--harness <file>` with an empty HOME, as on a CI machine: a spec that
 *     picks the model and leaves out two tools;
 *   - `--harness <name>` with that Agent defined in a temporary user settings
 *     file, in stream-json;
 * and checks that the run succeeds with the model's reply, that the output
 * matches the schema, that the Agent's tools reach `system/init`, and that
 * `result.harness` carries the name and the hash `eagent harness show`
 * reports. Then a run without `--harness`, and a missing file and an
 * unknown name, which must fail before any request.
 *
 * Run from a workspace whose settings define the profiles:
 *   npx tsx scripts/verify-headless-harness-live.ts MiniMax-M3 gpt5-M
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Ajv } from "ajv";

const handles = process.argv.slice(2);
if (handles.length === 0) {
  console.error("Usage: npx tsx scripts/verify-headless-harness-live.ts <model handle>...");
  process.exit(2);
}
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(PROJECT_ROOT, "dist", "eagent.js");
if (!existsSync(CLI)) {
  console.error(`${CLI} is missing; run npm run build first.`);
  process.exit(2);
}
const cwd = process.cwd();
const PROMPT = "只回复 OK 两个字母，不要调用任何工具。";
const LEFT_OUT = ["WebFetch", "WebSearch"];

const validateOutput = new Ajv({ strictRequired: false, allowUnionTypes: true }).compile(
  JSON.parse(await readFile(path.join(PROJECT_ROOT, "docs", "headless-output.schema.json"), "utf8")),
);

const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-headless-harness-live-"));
const ciHome = path.join(root, "ci-home");
const userHome = path.join(root, "user-home");
await Promise.all([mkdir(ciHome, { recursive: true }), mkdir(path.join(userHome, ".easy-agent"), { recursive: true })]);
const agentName = (handle: string) => `live-${handle.replace(/[^A-Za-z0-9-]/g, "-")}`;
await writeFile(
  path.join(userHome, ".easy-agent", "settings.json"),
  JSON.stringify({
    harnesses: Object.fromEntries(
      handles.map((handle) => [agentName(handle), { model: { main: handle }, tools: { exclude: LEFT_OUT } }]),
    ),
  }),
);

function runCli(args: string[], home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, "--trust-project-config"], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 300_000);
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

type Line = Record<string, unknown> & { harness?: { name: string; hash: string } };

async function headless(args: string[], home: string): Promise<Line[]> {
  const run = await runCli(["-p", PROMPT, ...args], home);
  const lines = run.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
  const result = lines.at(-1);
  assert.equal(run.code, 0, `${run.stderr.trim()}\n${result?.result ?? ""}`);
  for (const line of lines) assert.ok(validateOutput(line), JSON.stringify(validateOutput.errors));
  assert.equal(result?.type, "result");
  assert.equal(result?.subtype, "success");
  assert.match(String(result?.result), /OK/i, "the model replied");
  return lines;
}

async function shown(target: string[], home: string): Promise<{ name: string; hash: string }> {
  const run = await runCli(["harness", "show", ...target, "--json"], home);
  assert.equal(run.code, 0, run.stderr);
  const { name, hash } = (JSON.parse(run.stdout) as { harness: { name: string; hash: string } }).harness;
  return { name, hash };
}

let failed = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ${detail}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}: ${error instanceof Error ? error.message.split("\n").slice(0, 3).join(" / ") : error}`);
  }
}

try {
  for (const handle of handles) {
    console.log(`\n${handle}`);
    const specFile = path.join(root, `${agentName(handle)}.json`);
    await writeFile(specFile, JSON.stringify({ model: { main: handle }, tools: { exclude: LEFT_OUT } }));

    await check("--harness <file>, empty HOME, json", async () => {
      const [result] = await headless(["--harness", specFile, "--output-format", "json"], ciHome);
      assert.deepEqual(result?.harness, await shown([specFile], ciHome));
      assert.equal(result?.harness?.name, "(inline)");
      return `${JSON.stringify(result?.harness)} reply=${JSON.stringify(result?.result)}`;
    });

    await check("--harness <name>, stream-json", async () => {
      const name = agentName(handle);
      const lines = await headless(["--harness", name, "--output-format", "stream-json"], userHome);
      const init = lines[0]!;
      const result = lines.at(-1)!;
      assert.equal(init.subtype, "init");
      for (const tool of LEFT_OUT) assert.ok(!(init.tools as string[]).includes(tool), `${tool} is left out`);
      assert.ok((init.tools as string[]).includes("Read"));
      assert.deepEqual(result.harness, await shown([name], userHome));
      assert.equal(result.harness?.name, name);
      return `${JSON.stringify(result.harness)} model=${String(init.model)} reply=${JSON.stringify(result.result)}`;
    });
  }

  console.log("\nworkspace default");
  await check("without --harness, json", async () => {
    const [result] = await headless(["--output-format", "json"], userHome);
    assert.deepEqual(result?.harness, await shown([], userHome));
    assert.equal(result?.harness?.name, "default");
    return `${JSON.stringify(result?.harness)} reply=${JSON.stringify(result?.result)}`;
  });

  console.log("\nselections that do not resolve");
  for (const [label, target, reason] of [
    ["missing file", path.join(root, "missing.json"), /--harness: cannot read/],
    ["unknown name", "ghost", /no Agent named "ghost"/],
  ] as const) {
    await check(`${label} exits 1 before any request`, async () => {
      const started = Date.now();
      const run = await runCli(["-p", PROMPT, "--harness", target, "--output-format", "json"], userHome);
      assert.equal(run.code, 1);
      assert.match(run.stderr, reason);
      assert.equal(run.stdout, "");
      return `${Date.now() - started}ms stderr=${JSON.stringify(run.stderr.trim().slice(0, 120))}`;
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed.` : "\nAll live checks passed.");
process.exitCode = failed ? 1 : 0;

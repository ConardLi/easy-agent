import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runTools } from "../core/agenticLoop.js";
import type { Tool } from "../tools/Tool.js";
import { getAllTools, registerMcpTools } from "../tools/index.js";
import { powerShellTool } from "../tools/powerShellTool.js";
import { hasValidToolInputSchema, validateToolInput } from "../tools/inputValidation.js";
import { _resetHooksSettingsCache } from "../hooks/runHooks.js";

const cwd = await mkdtemp(path.join(os.tmpdir(), "easy-agent-tool-input-"));
const originalHome = process.env.HOME;
process.env.HOME = cwd;
let calls = 0;
let permissionChecks = 0;
let concurrencyChecks = 0;
const fixture: Tool = {
  name: "ValidationFixture",
  description: "Test tool input validation",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "write"] },
      count: { type: "number", minimum: 1, maximum: 10 },
      label: { type: "string", minLength: 2, maxLength: 8 },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  isReadOnly: () => {
    permissionChecks += 1;
    return true;
  },
  isEnabled: () => true,
  isConcurrencySafe: () => {
    concurrencyChecks += 1;
    return true;
  },
  async call() {
    calls += 1;
    return { content: "called" };
  },
};

try {
  const settingsDir = path.join(cwd, ".easy-agent");
  await mkdir(settingsDir);
  const marker = path.join(cwd, "hook-marker");
  const hookShellAvailable =
    process.platform !== "win32" && spawnSync("bash", ["-c", "printf ready"], { encoding: "utf8" }).stdout === "ready";
  if (hookShellAvailable) {
    await writeFile(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: fixture.name, hooks: [{ type: "command", command: "printf 'hit\\n' >> hook-marker" }] },
          ],
        },
      }),
    );
  }
  _resetHooksSettingsCache();

  async function run(input: unknown): Promise<string> {
    const result = await runTools(
      [{ type: "tool_use", id: "fixture-call", name: fixture.name, input } as never],
      { cwd },
      { availableTools: [fixture] },
    );
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0]?.result.isError, true);
    return String(result.executions[0]?.result.content);
  }

  const invalidCases: Array<[unknown, RegExp]> = [
    [{}, /\$\.action is required/],
    [{ action: 1 }, /\$\.action must be string/],
    [{ action: "delete" }, /\$\.action must be an allowed value/],
    [{ action: "read", count: 0 }, /\$\.count is below the minimum/],
    [{ action: "read", count: 11 }, /\$\.count is above the maximum/],
    [{ action: "read", label: "x" }, /\$\.label is too short/],
    [{ action: "read", label: "123456789" }, /\$\.label is too long/],
    [{ action: "read", extra: true }, /\$\.extra is not allowed/],
    [{ action: "read", items: [{ value: "ok", extra: true }] }, /\$\.items\[0\]\.extra is not allowed/],
    [{ action: "read", items: [{}] }, /\$\.items\[0\]\.value is required/],
    [null, /\$ must be an object/],
    [["read"], /\$ must be an object/],
    [JSON.parse('{"action":"read","__proto__":{"polluted":true}}'), /reserved field/],
  ];
  for (const [input, expected] of invalidCases) assert.match(await run(input), expected);
  const secret = "sensitive-token-value";
  assert.ok(!(await run({ action: "read", count: secret })).includes(secret));
  assert.equal(calls, 0);
  assert.equal(permissionChecks, 0);
  assert.equal(concurrencyChecks, 0);
  if (hookShellAvailable) await assert.rejects(readFile(marker), { code: "ENOENT" });

  const validResult = await runTools(
    [
      {
        type: "tool_use",
        id: "valid",
        name: fixture.name,
        input: { action: "read", count: 2, label: "okay", items: [{ value: "ok" }] },
      },
    ],
    { cwd },
    { availableTools: [fixture] },
  );
  assert.equal(validResult.executions[0]?.result.content, "called");
  assert.equal(calls, 1);
  assert.ok(permissionChecks > 0);
  assert.equal(concurrencyChecks, 1);
  if (hookShellAvailable) assert.equal(await readFile(marker, "utf8"), "hit\n");

  const deep: Record<string, unknown> = { action: "read" };
  let cursor = deep;
  for (let index = 0; index < 70; index++) {
    const next: Record<string, unknown> = {};
    cursor.nested = next;
    cursor = next;
  }
  const deepResult = validateToolInput(fixture, deep);
  assert.equal(deepResult.ok, false);
  if (!deepResult.ok) assert.match(deepResult.message, /deeply nested/);
  const oversized = validateToolInput(fixture, { action: "read", label: "x".repeat(8 * 1024 * 1024 + 1) });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.match(oversized.message, /MiB limit/);
  const cyclic: Record<string, unknown> = { action: "read" };
  cyclic.self = cyclic;
  assert.equal(validateToolInput(fixture, cyclic).ok, false);
  const accessor = {
    action: "read",
    get token() {
      throw new Error("getter executed");
    },
  };
  assert.equal(validateToolInput(fixture, accessor).ok, false);
  const throwingProxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("proxy executed");
      },
    },
  );
  assert.equal(validateToolInput(fixture, throwingProxy).ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  let seed = 0x12345678;
  for (let index = 0; index < 200; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const input = { action: `invalid-${seed % 37}`, count: (seed % 20) - 5, items: [{ value: index % 2 ? 1 : "ok" }] };
    assert.equal(validateToolInput(fixture, input).ok, false);
  }

  const invalidSchema: Tool = {
    ...fixture,
    name: "InvalidSchema",
    inputSchema: { type: "object", required: "not-an-array" } as never,
  };
  assert.equal(hasValidToolInputSchema(invalidSchema), false);
  assert.equal(validateToolInput(invalidSchema, { action: "read" }).ok, false);
  const sharedSchemaId = "https://example.test/tool-schema";
  const firstMcpTool: Tool = {
    ...fixture,
    name: "mcp__first__action",
    isMcp: true,
    inputSchema: {
      $id: sharedSchemaId,
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    } as never,
  };
  const secondMcpTool: Tool = {
    ...fixture,
    name: "mcp__second__action",
    isMcp: true,
    inputSchema: {
      $id: sharedSchemaId,
      type: "object",
      properties: { action: { type: "number" } },
      required: ["action"],
    } as never,
  };
  assert.equal(hasValidToolInputSchema(firstMcpTool), true);
  assert.equal(hasValidToolInputSchema(secondMcpTool), true);
  assert.equal(validateToolInput(firstMcpTool, { action: "read" }).ok, true);
  assert.equal(validateToolInput(secondMcpTool, { action: 2 }).ok, true);
  const draft2020Tool: Tool = {
    ...fixture,
    name: "mcp__fixture__draft2020",
    isMcp: true,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    } as never,
  };
  assert.equal(hasValidToolInputSchema(draft2020Tool), true);
  assert.equal(validateToolInput(draft2020Tool, { action: "read" }).ok, true);
  registerMcpTools([
    { ...fixture, name: "mcp__fixture__valid", isMcp: true },
    { ...invalidSchema, name: "mcp__fixture__invalid", isMcp: true },
  ]);
  assert.ok(getAllTools().some((tool) => tool.name === "mcp__fixture__valid"));
  assert.ok(!getAllTools().some((tool) => tool.name === "mcp__fixture__invalid"));

  const builtinInputs: Record<string, Record<string, unknown>> = {
    Read: { file_path: "README.md", extra: "legacy field" },
    Write: { file_path: "file.txt", content: "text" },
    Edit: { file_path: "file.txt", old_string: "a", new_string: "b" },
    MultiEdit: { file_path: "file.txt", edits: [{ old_string: "a", new_string: "b" }] },
    Glob: { pattern: "*.ts" },
    Grep: { pattern: "query" },
    Bash: { command: "pwd" },
    PowerShell: { command: "Get-Location" },
    WebFetch: { url: "https://example.com", prompt: "summarize" },
    WebSearch: { query: "easy agent" },
    ListMcpResources: {},
    ReadMcpResource: { server: "fixture", uri: "memo://one" },
    MemoryWrite: { name: "note", description: "description", type: "project", content: "text" },
    TaskCreate: { subject: "task", description: "description" },
    TaskUpdate: { taskId: "1" },
    TaskGet: { taskId: "1" },
    TaskList: {},
    EnterPlanMode: { reason: "plan" },
    ExitPlanMode: { summary: "done" },
    Skill: { skill: "fixture" },
    AskUserQuestion: {
      questions: [{ question: "Continue?", header: "Next", options: [{ label: "Yes" }, { label: "No" }] }],
    },
    Agent: { prompt: "Review this file", description: "review" },
    ToolSearch: { query: "read files" },
  };
  for (const tool of getAllTools().filter((tool) => !tool.isMcp)) {
    assert.equal(validateToolInput(tool, builtinInputs[tool.name]).ok, true, `valid ${tool.name} input`);
  }
  assert.equal(validateToolInput(powerShellTool, builtinInputs.PowerShell).ok, true, "valid PowerShell input");
  console.log("Tool input validation checks passed.");
} finally {
  registerMcpTools([]);
  _resetHooksSettingsCache();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(cwd, { recursive: true, force: true });
}

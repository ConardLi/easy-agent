#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsSchema, validateSettings } from "../config/schema.js";
import { resolveFeatureSettings, loadFeatureSettings } from "../config/features.js";
import { setFlagSettings, resetSettingsCache, type LoadedSource } from "../config/sources.js";
import { PluginManifestSchema } from "../plugins/schemas.js";
import { trustProjectForSession, resetGlobalStateCache } from "../config/globalState.js";
import { getProjectSettingsPath, getUserSettingsPath } from "../utils/paths.js";
import { applyLspServers, stopAllLspServers } from "../services/lsp/runtime.js";
import { lspTool } from "../tools/lspTool.js";
import { setAgents } from "../agents/registry.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { skillTool } from "../tools/skillTool.js";
import { setSkills } from "../services/skills/registry.js";
import type { Skill } from "../types/types.js";

const root = await mkdtemp(join(tmpdir(), "ea-feature-config-"));
const home = join(root, "home");
const cwd = join(root, "project");
await mkdir(home, { recursive: true });
await mkdir(cwd, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
const savedEnv = process.env.EASY_AGENT_ENABLE_TOOL_SEARCH;
delete process.env.EASY_AGENT_ENABLE_TOOL_SEARCH;
delete process.env.ENABLE_TOOL_SEARCH;
const source = (name: LoadedSource["source"], raw: Record<string, unknown>): LoadedSource => ({
  source: name,
  path: null,
  raw,
});
try {
  assert.equal(SettingsSchema.safeParse({ toolSearch: "invalid" }).success, false);
  const invalid = validateSettings({ toolSearch: "invalid", unknownField: true }, "fixture");
  assert(invalid.errors.some((error) => error.includes("toolSearch")));
  assert(invalid.errors.some((error) => error.includes('unsupported setting "unknownField"')));

  const resolved = resolveFeatureSettings(
    [
      source("user", { toolSearch: "auto", toolSearchAutoThreshold: 20, modelRoles: { background: "user-bg" } }),
      source("project", { toolSearch: "off", modelRoles: { think: "project-think" } }),
      source("local", { toolSearch: "on" }),
      source("flag", { toolSearch: "off" }),
      source("policy", { toolSearch: "auto", toolSearchAutoThreshold: 30 }),
    ],
    {},
  );
  assert.equal(resolved.toolSearch, "auto");
  assert.equal(resolved.toolSearchAutoThreshold, 30);
  assert.equal(resolved.modelRoles.background, "user-bg");
  assert.equal(resolved.modelRoles.think, "project-think");
  const envResolved = resolveFeatureSettings(
    [source("user", { toolSearch: "off" }), source("flag", { toolSearch: "on" })],
    { EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:25" },
  );
  assert.equal(envResolved.toolSearch, "on", "CLI flag wins over legacy environment");
  assert(envResolved.warnings.some((warning) => warning.includes("deprecated")));

  await trustProjectForSession(cwd);
  const projectFile = getProjectSettingsPath(cwd);
  const userFile = getUserSettingsPath();
  await mkdir(join(cwd, ".easy-agent"), { recursive: true });
  await mkdir(join(home, ".easy-agent"), { recursive: true });
  await writeFile(userFile, JSON.stringify({ toolSearch: "auto", modelRoles: { background: "bg-model" } }));
  await writeFile(projectFile, JSON.stringify({ toolSearch: "off" }));
  resetSettingsCache();
  assert.equal((await loadFeatureSettings(cwd)).toolSearch, "off");
  await writeFile(projectFile, "{invalid");
  resetSettingsCache();
  const fallback = await loadFeatureSettings(cwd);
  assert.equal(fallback.toolSearch, "off", "invalid live update retains the last valid source snapshot");
  assert(fallback.warnings.some((warning) => warning.includes("retained last valid")));
  await writeFile(projectFile, JSON.stringify({ toolSearch: "on" }));
  resetSettingsCache();
  assert.equal((await loadFeatureSettings(cwd)).toolSearch, "on", "fixed update publishes atomically");
  setFlagSettings({ toolSearch: "auto", toolSearchAutoThreshold: 5 });
  assert.equal((await loadFeatureSettings(cwd)).toolSearch, "auto");
  setFlagSettings(null);

  const validLsp = {
    name: "example",
    lspServers: { fake: { command: process.execPath, args: [], extensionToLanguage: { ".ts": "typescript" } } },
  };
  assert(PluginManifestSchema.safeParse(validLsp).success);
  assert.equal(
    PluginManifestSchema.safeParse({ name: "example", lspServers: { fake: { command: "x" } } }).success,
    false,
  );
  const fakeServer = join(root, "fake-lsp.mjs");
  await writeFile(
    fakeServer,
    `let b=Buffer.alloc(0);process.stdin.on('data',c=>{b=Buffer.concat([b,c]);for(;;){let i=b.indexOf('\\r\\n\\r\\n');if(i<0)return;let m=/Content-Length:\\s*(\\d+)/i.exec(b.subarray(0,i).toString());if(!m)return;let n=Number(m[1]);if(b.length<i+4+n)return;let q=JSON.parse(b.subarray(i+4,i+4+n));b=b.subarray(i+4+n);if(q.id!==undefined){let result=q.method==='initialize'?{capabilities:{textDocumentSync:1}}:q.method==='textDocument/hover'?{contents:'hover-ok'}:null;let s=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));process.stdout.write('Content-Length: '+s.length+'\\r\\n\\r\\n');process.stdout.write(s)}}});`,
  );
  const lspErrors = await applyLspServers([
    {
      name: "fake",
      cwd,
      config: {
        command: process.execPath,
        args: [fakeServer],
        extensionToLanguage: { ".ts": "typescript" },
        transport: "stdio",
        startupTimeout: 3000,
        requestTimeout: 3000,
        restartOnCrash: true,
        maxRestarts: 1,
      },
    },
  ]);
  assert.deepEqual(lspErrors, []);
  const tsFile = join(cwd, "sample.ts");
  await writeFile(tsFile, "const value = 1;\n");
  const lspResult = await lspTool.call({ operation: "hover", file_path: tsFile, line: 0, character: 6 }, { cwd });
  assert.equal(lspResult.isError, undefined);
  assert.match(String(lspResult.content), /hover-ok/);
  await stopAllLspServers();

  setAgents(getBuiltInAgents());
  const forkSkill: Skill = {
    name: "fork-test",
    description: "fork",
    body: "Answer FORK_OK",
    filePath: join(root, "SKILL.md"),
    baseDir: root,
    source: "user",
    frontmatter: {
      name: "fork-test",
      description: "fork",
      allowedTools: [],
      disableModelInvocation: false,
      hasForkContext: true,
      raw: { context: "fork" },
    },
  };
  setSkills([forkSkill]);
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "fixture-token";
  globalThis.fetch = (async () => {
    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    return new Response(
      [
        event("message_start", {
          type: "message_start",
          message: {
            id: "m",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }),
        event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "FORK_OK" },
        }),
        event("content_block_stop", { type: "content_block_stop", index: 0 }),
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        event("message_stop", { type: "message_stop" }),
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const forkResult = await skillTool.call(
    { skill: "fork-test" },
    { cwd, defaultModel: "claude-sonnet-4-5", availableTools: [skillTool] },
  );
  globalThis.fetch = oldFetch;
  if (oldToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = oldToken;
  assert.equal(forkResult.isError, undefined, `fork failed: ${String(forkResult.content)}`);
  assert.match(String(forkResult.content), /FORK_OK/);
  console.log("Feature configuration, atomic reload, LSP and fork-skill checks passed.");
} finally {
  if (savedEnv === undefined) delete process.env.EASY_AGENT_ENABLE_TOOL_SEARCH;
  else process.env.EASY_AGENT_ENABLE_TOOL_SEARCH = savedEnv;
  await stopAllLspServers();
  resetGlobalStateCache();
  setFlagSettings(null);
  await rm(root, { recursive: true, force: true });
}

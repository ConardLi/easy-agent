import { expect, test } from "@playwright/test";
import {
  applySelection,
  lockedBy,
  offByAgent,
  selectionState,
  setKey,
  sourceText,
  specSections,
  toggleSection,
  toggleSelection,
} from "../../src/renderer/features/agents/model";
import type { ResolvedHarness, ResolvedHarnessValue } from "../../src/shared/agent";

/** A resolved Agent with only the given values, the way `runtime/harness` returns it. */
function resolved(name: string, values: Record<string, Partial<ResolvedHarnessValue>>): ResolvedHarness {
  return {
    name,
    chain: [name],
    hash: "h",
    issues: [],
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, { source: "harness", detail: name, applied: true, contributions: [], ignored: [], ...v }]),
    ),
  } as unknown as ResolvedHarness;
}

test("a switch copies the inherited list into the Agent's own spec, since a child's list replaces its parent's", () => {
  const child = resolved("docs", { "tools.exclude": { value: ["Write", "Bash"], detail: "reviewer" } });
  expect(selectionState(child, "tools", "Write")).toMatchObject({ on: false, reason: "从 reviewer 继承的 tools.exclude 去掉了它" });
  expect(toggleSelection({ extends: "reviewer" }, child, "tools", "Write", true)).toEqual({ extends: "reviewer", tools: { exclude: ["Bash"] } });
  expect(toggleSelection({}, child, "tools", "Read", false)).toEqual({ tools: { exclude: ["Write", "Bash", "Read"] } });
  // Turning the last one back on keeps an empty list, so the parent's list does not come back.
  const own = resolved("docs", { "tools.exclude": { value: ["Bash"] } });
  expect(toggleSelection({ tools: { exclude: ["Bash"] } }, own, "tools", "Bash", true)).toEqual({ tools: { exclude: [] } });
});

test("with an include list, on adds to it and off removes from it; patterns are excluded by name", () => {
  const only = resolved("lean", { "tools.include": { value: ["Read", "mcp__*"] } });
  expect(selectionState(only, "tools", "Grep")).toMatchObject({ on: false, reason: "不在这个 Agent 的 tools.include 里" });
  expect(selectionState(only, "tools", "mcp__github__x").on).toBe(true);
  expect(toggleSelection({}, only, "tools", "Grep", true)).toEqual({ tools: { include: ["Read", "mcp__*", "Grep"] } });
  expect(toggleSelection({}, only, "tools", "Read", false)).toEqual({ tools: { include: ["mcp__*"] } });
  expect(toggleSelection({}, only, "tools", "mcp__github__x", false)).toEqual({ tools: { exclude: ["mcp__github__x"] } });
  expect(
    applySelection({}, only, "tools", [
      ["Grep", true],
      ["Read", false],
    ]),
  ).toEqual({ tools: { include: ["mcp__*", "Grep"] } });
});

test("setKey writes one leaf and drops the objects a removal leaves empty", () => {
  expect(setKey({ prompt: { identity: "x" } }, "prompt.identity", undefined)).toEqual({});
  expect(setKey({ prompt: { identity: "x", language: "zh" } }, "prompt.identity", undefined)).toEqual({ prompt: { language: "zh" } });
  const spec = { a: 1 };
  expect(setKey(spec, "features.maxTurns", 9)).toEqual({ a: 1, features: { maxTurns: 9 } });
  expect(spec).toEqual({ a: 1 });
});

test("prompt sections go back to spec form, and turning one on writes true so a parent cannot turn it off", () => {
  const value = { language: false, rules: { text: "Be brief.", file: "/home/u/.easy-agent/prompts/x.md", after: "agent_md" }, notes: { text: "inline" } };
  const r = resolved("x", { "prompt.sections": { value, detail: "base" } });
  expect(specSections(r)).toEqual({ language: false, rules: { file: "/home/u/.easy-agent/prompts/x.md", after: "agent_md" }, notes: { text: "inline" } });
  expect(toggleSection(r, "language", true).language).toBe(true);
  expect(toggleSection(r, "memory", false).memory).toBe(false);
  expect(toggleSection(r, "rules", true).rules).toEqual({ file: "/home/u/.easy-agent/prompts/x.md", after: "agent_md" });
});

test("sources read as this Agent, inherited, or the layer above that locks the value", () => {
  expect(sourceText({ source: "harness", detail: "a" }, "a")).toBe("这个 Agent");
  expect(sourceText({ source: "harness", detail: "base" }, "a")).toBe("继承自 base");
  expect(lockedBy({ source: "harness", detail: "a" })).toBeUndefined();
  expect(lockedBy({ source: "user", detail: "maxTurns" })).toBeUndefined();
  expect(lockedBy({ source: "project", detail: "maxTurns" })).toBe("被项目设置覆盖：.easy-agent/settings.json 的 maxTurns");
  expect(lockedBy({ source: "environment", detail: "EASY_AGENT_MAX_RETRIES" })).toBe("被环境变量覆盖：EASY_AGENT_MAX_RETRIES");
  expect(lockedBy({ source: "policy", detail: "sandbox.enabled" })).toBe("被托管策略收紧：managed-settings.json 的 sandbox.enabled");
  expect(offByAgent("tools", 'Left out by tools.exclude (Agent "a").')).toBe(true);
  expect(offByAgent("tools", "Turned off by its feature setting or not available on this platform.")).toBe(false);
  expect(offByAgent("mcpServers", 'Not in mcpServers.include (Agent "a").')).toBe(true);
});

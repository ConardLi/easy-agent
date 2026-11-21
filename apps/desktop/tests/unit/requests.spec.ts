import { expect, test } from "@playwright/test";
import { componentName, componentSource, configureTarget } from "../../src/renderer/features/requests/model";

test("component navigation preserves plugin namespaces, absolute paths, and MCP server names", () => {
  expect(configureTarget("skill:plugin:kit:review")).toEqual({ tab: "skills", row: "skills:kit:review" });
  expect(componentName("skill:plugin:kit:review")).toBe("/kit:review");
  expect(componentSource("skill:plugin:kit:review", { pluginId: "kit@market" })).toBe("插件 · kit@market");
  expect(configureTarget("agent:project:repo:reviewer")).toEqual({ tab: "agents", row: "agents:repo:reviewer" });
  expect(configureTarget("rule:C:\\work\\AGENTS.md")).toEqual({ tab: "resources", row: "rules:C:\\work\\AGENTS.md" });
  expect(componentName("rule:C:\\work\\AGENTS.md")).toBe("AGENTS.md");
  expect(componentSource("rule:/repo/AGENTS.md")).toBe("/repo/AGENTS.md");
  expect(configureTarget("tool:mcp__github-prod__search")).toEqual({ tab: "mcp", row: "mcpServers:github-prod" });
});

test("context and message sources link only to settings that can control them", () => {
  expect(configureTarget("context_source:agent_md")).toEqual({ tab: "context", row: "context.agentMd" });
  expect(configureTarget("context_source:git_status")).toEqual({ tab: "context", row: "context.gitStatus" });
  expect(configureTarget("rule:memory")).toEqual({ tab: "context", row: "context.memory" });
  expect(configureTarget("prompt_section:identity")).toEqual({ tab: "prompt", row: "prompt.identity" });
  expect(configureTarget("prompt_section:instructions")).toBeUndefined();
  expect(configureTarget("message:deferred_tools")).toEqual({ tab: "features", row: "features.toolSearch" });
  expect(configureTarget("message:assistant")).toBeUndefined();
  expect(configureTarget("request:envelope")).toBeUndefined();
});

#!/usr/bin/env tsx
/**
 * Stage 19 verification script — exercise the Sub-Agent subsystem WITHOUT
 * touching the LLM. Validates the loader, registry, tool resolver,
 * built-in agents, system-prompt formatter, AgentTool input handling, and
 * permission interactions.
 *
 * Why no LLM round-trip here: spinning up a real sub-agent loop hits the
 * Anthropic API, costs money, and is non-deterministic. The end-to-end
 * smoke is left for the user to run interactively via `npm run dev`. The
 * checks below catch the mechanical mistakes that are 95% of the bugs.
 *
 * Usage:
 *   cd easy-agent
 *   npx tsx src/scripts/test-agents.ts
 *
 * Exits non-zero on any assertion failure.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { bootstrapAgents } from "../agents/bootstrap.js";
import { clearAgents, findAgent, getAllAgents, setAgents } from "../agents/registry.js";
import { getBuiltInAgents } from "../agents/builtIn/index.js";
import { loadAllCustomAgents } from "../agents/loadAgentsDir.js";
import { AGENT_TOOL_NAME, resolveAgentTools } from "../agents/resolveAgentTools.js";
import { formatAgentsSystemReminder } from "../agents/promptInjection.js";
import { agentTool } from "../tools/agentTool.js";
import { toolResultText } from "../tools/Tool.js";
import { getAllTools } from "../tools/index.js";
import { checkPermission } from "../permissions/permissions.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

async function withTempProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-agents-"));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("\n[1] Built-in agent definitions");
  const builtIns = getBuiltInAgents();
  assert(builtIns.length === 2, "exactly 2 built-in agents (general-purpose, Explore)");
  assert(
    builtIns.some((a) => a.agentType === "general-purpose"),
    "general-purpose agent is built-in",
  );
  assert(
    builtIns.some((a) => a.agentType === "Explore"),
    "Explore agent is built-in",
  );
  const explore = builtIns.find((a) => a.agentType === "Explore");
  assert(explore?.disallowedTools?.includes("Write"), "Explore agent disallows Write");
  assert(explore?.disallowedTools?.includes("Edit"), "Explore agent disallows Edit");
  const exploreSP = explore?.getSystemPrompt() ?? "";
  assert(exploreSP.includes("READ-ONLY"), "Explore system prompt enforces read-only mode");
  const generalPurpose = builtIns.find((a) => a.agentType === "general-purpose");
  assert(
    !generalPurpose?.tools && !generalPurpose?.disallowedTools,
    "general-purpose has no tools / disallowedTools (wildcard)",
  );

  console.log("\n[2] resolveAgentTools — wildcard + Agent stripping");
  const allTools = getAllTools();
  assert(
    allTools.some((t) => t.name === AGENT_TOOL_NAME),
    "Agent tool is registered in the global tool pool",
  );
  const wildcardResolved = resolveAgentTools({}, allTools);
  assert(wildcardResolved.hasWildcard, "undefined `tools` → wildcard");
  assert(
    !wildcardResolved.resolvedTools.some((t) => t.name === AGENT_TOOL_NAME),
    "wildcard resolution strips Agent tool itself (no recursion)",
  );
  const starResolved = resolveAgentTools({ tools: ["*"] }, allTools);
  assert(starResolved.hasWildcard, "`tools: ['*']` → wildcard");

  console.log("\n[3] resolveAgentTools — disallowedTools applies under wildcard");
  const exploreResolved = resolveAgentTools({ disallowedTools: ["Write", "Edit", "MemoryWrite"] }, allTools);
  assert(exploreResolved.hasWildcard, "Explore-style resolution still wildcard");
  assert(!exploreResolved.resolvedTools.some((t) => t.name === "Write"), "Write is removed by disallowedTools");
  assert(!exploreResolved.resolvedTools.some((t) => t.name === "Edit"), "Edit is removed by disallowedTools");
  assert(
    exploreResolved.resolvedTools.some((t) => t.name === "Read"),
    "Read survives the disallow",
  );

  console.log("\n[4] resolveAgentTools — explicit allow-list intersect");
  const reviewerResolved = resolveAgentTools({ tools: ["Read", "Grep", "Glob", "Bash", "Bogus"] }, allTools);
  assert(!reviewerResolved.hasWildcard, "explicit `tools` → not wildcard");
  assert(reviewerResolved.resolvedTools.length === 4, "explicit allow-list produces 4 valid tools");
  assert(reviewerResolved.invalidTools.includes("Bogus"), "unknown tool name surfaces in invalidTools");
  assert(
    !reviewerResolved.resolvedTools.some((t) => t.name === AGENT_TOOL_NAME),
    "explicit list still cannot opt-in to the Agent tool (no recursion)",
  );

  console.log("\n[5] Custom agent loading + override");
  await withTempProject(async (cwd) => {
    const agentsDir = path.join(cwd, ".easy-agent", "agents");
    await fs.mkdir(agentsDir, { recursive: true });

    // (a) A reviewer agent (custom name).
    await fs.writeFile(
      path.join(agentsDir, "reviewer.md"),
      [
        "---",
        'name: "reviewer"',
        'description: "Code review specialist"',
        'tools: "Read,Glob,Grep,Bash"',
        'disallowedTools: "Write,Edit"',
        "maxTurns: 12",
        "---",
        "You are a code review specialist. Review the diff and report findings.",
      ].join("\n"),
    );

    // (b) An override of the built-in Explore agent — same agentType.
    await fs.writeFile(
      path.join(agentsDir, "Explore.md"),
      [
        "---",
        'name: "Explore"',
        'description: "Custom Explore override (project-scope)"',
        "---",
        "Custom Explore prompt.",
      ].join("\n"),
    );

    // (c) An invalid file — missing description. Should be skipped with warning.
    await fs.writeFile(
      path.join(agentsDir, "broken.md"),
      ["---", 'name: "broken"', "---", "missing description, should be skipped"].join("\n"),
    );

    const result = await bootstrapAgents(cwd);
    assert(result.builtInCount === 2, "bootstrap reports 2 built-ins");
    assert(result.customCount === 2, "bootstrap reports 2 valid custom agents (reviewer + Explore override)");
    assert(
      result.warnings.some((w) => w.includes("broken.md")),
      "broken.md skipped with warning",
    );

    const reviewer = findAgent("reviewer");
    assert(reviewer, "reviewer agent loaded by name");
    assert(
      reviewer?.tools?.length === 4 && reviewer.tools.includes("Read") && reviewer.tools.includes("Bash"),
      "reviewer parses CSV `tools` field correctly",
    );
    assert(
      reviewer?.disallowedTools?.includes("Write") && reviewer.disallowedTools.includes("Edit"),
      "reviewer parses CSV `disallowedTools` field correctly",
    );
    assert(reviewer?.maxTurns === 12, "reviewer maxTurns parsed as 12");
    assert(reviewer?.source === "project", "reviewer source is 'project'");

    const exploreAfter = findAgent("Explore");
    assert(exploreAfter?.source === "project", "Explore is now the project-scope override (built-in shadowed)");
    assert(
      exploreAfter?.getSystemPrompt() === "Custom Explore prompt.",
      "Custom Explore body wins over the built-in's READ-ONLY prompt",
    );

    console.log("\n[6] resolveAgentTools — wildcard with no disallow + override semantics");
    // The custom Explore declares no tools/disallowedTools, so it gets
    // wildcard with NO write protection. This intentionally mirrors source
    // — overriding the built-in means you take responsibility for the
    // safeguards too. Verify the resolver reflects that.
    const overrideResolved = resolveAgentTools(exploreAfter ?? {}, allTools);
    assert(overrideResolved.hasWildcard, "custom Explore (no tools field) is wildcard");
    assert(
      overrideResolved.resolvedTools.some((t) => t.name === "Write"),
      "custom Explore can use Write — overrides drop the built-in's safeguards",
    );

    console.log("\n[7] System prompt — agents <system-reminder> block");
    const parts = await buildSystemPrompt({ cwd });
    const rendered = renderSystemPrompt(parts);
    assert(
      rendered.includes("Available sub-agents you can invoke via the `Agent` tool"),
      "system prompt contains the agents reminder header",
    );
    assert(rendered.includes("- general-purpose [built-in]"), "system prompt lists general-purpose as built-in");
    assert(rendered.includes("- Explore [project]"), "system prompt lists Explore as project (override took effect)");
    assert(rendered.includes("- reviewer [project]"), "system prompt lists reviewer as project");

    console.log("\n[8] AgentTool — input validation + lookup errors");
    const cwdContext = { cwd, sessionId: "test-session" };

    const missingPrompt = await agentTool.call({}, cwdContext);
    assert(missingPrompt.isError, "missing prompt is an error");
    assert(
      toolResultText(missingPrompt.content).includes("'prompt' is required"),
      "error message mentions 'prompt' required",
    );

    const unknownAgent = await agentTool.call(
      { prompt: "do something", description: "test", subagent_type: "does-not-exist" },
      cwdContext,
    );
    assert(unknownAgent.isError, "unknown agent type is an error");
    assert(toolResultText(unknownAgent.content).includes("'does-not-exist'"), "error message names the bad agent type");
    assert(toolResultText(unknownAgent.content).includes("Available types"), "error lists available agent types");

    console.log("\n[9] Permissions — Agent tool decisions in each mode");
    // Default mode: Agent is read-only → auto-allow.
    const defaultDecision = await checkPermission({
      tool: agentTool,
      input: { prompt: "x", description: "y" },
      cwd,
      mode: "default",
      settings: { allow: [], deny: [], mode: "default" },
    });
    assert(defaultDecision.behavior === "allow", "Agent in default mode → allow (read-only delegation)");

    // Plan mode: Agent NOT in PLAN_ALLOWED_TOOLS → deny.
    const planDecision = await checkPermission({
      tool: agentTool,
      input: { prompt: "x", description: "y" },
      cwd,
      mode: "plan",
      settings: { allow: [], deny: [], mode: "plan" },
    });
    assert(planDecision.behavior === "deny", "Agent in plan mode → deny (only Read/Grep/Glob allowed)");

    // Auto mode: everything allowed.
    const autoDecision = await checkPermission({
      tool: agentTool,
      input: { prompt: "x", description: "y" },
      cwd,
      mode: "auto",
      settings: { allow: [], deny: [], mode: "auto" },
    });
    assert(autoDecision.behavior === "allow", "Agent in auto mode → allow");

    // Reset registry so subsequent test runs in this process don't see the
    // tmpdir-loaded agents (probably no callers, but cheap insurance).
    clearAgents();
  });

  console.log("\n[10] formatAgentsSystemReminder — empty + sorted");
  const empty = formatAgentsSystemReminder([]);
  assert(empty === "", "empty agents list → empty reminder string");

  setAgents([
    {
      agentType: "z-custom",
      whenToUse: "Z agent",
      source: "project",
      getSystemPrompt: () => "z",
    },
    {
      agentType: "a-custom",
      whenToUse: "A agent",
      source: "user",
      getSystemPrompt: () => "a",
    },
    {
      agentType: "Explore",
      whenToUse: "Explore",
      source: "built-in",
      getSystemPrompt: () => "explore",
    },
  ]);
  const sortedReminder = formatAgentsSystemReminder(getAllAgents());
  const idxBuiltIn = sortedReminder.indexOf("Explore [built-in]");
  const idxA = sortedReminder.indexOf("a-custom [user]");
  const idxZ = sortedReminder.indexOf("z-custom [project]");
  assert(idxBuiltIn !== -1, "Explore appears in sortedReminder");
  assert(idxA !== -1 && idxZ !== -1, "custom agents appear in sortedReminder");
  assert(idxBuiltIn < idxA && idxA < idxZ, "built-in sorted first, then alphabetical");
  clearAgents();

  console.log("\n[11] loadAllCustomAgents — empty / missing dir is silent");
  await withTempProject(async (cwd) => {
    const result = await loadAllCustomAgents(cwd);
    assert(result.agents.length === 0, "missing agents/ dir → 0 agents loaded");
    assert(result.warnings.length === 0, "missing agents/ dir → no warnings");
  });

  console.log("\n[12] subAgentProgressStore — start / update / complete / clear");
  {
    const {
      startSubAgentProgress,
      updateSubAgentProgress,
      completeSubAgentProgress,
      clearSubAgentProgress,
      getSubAgentProgress,
      subscribeSubAgentProgress,
      clearAllSubAgentProgress,
    } = await import("../state/subAgentProgressStore.js");

    clearAllSubAgentProgress();
    const events: Array<{ id: string; status?: string; tools?: number }> = [];
    const unsub = subscribeSubAgentProgress((id, snapshot) => {
      events.push({
        id,
        ...(snapshot ? { status: snapshot.status, tools: snapshot.toolUseCount } : {}),
      });
    });

    startSubAgentProgress("tool-1", { agentType: "Explore", description: "look around" });
    const initial = getSubAgentProgress("tool-1");
    assert(initial?.agentType === "Explore", "start → agentType captured");
    assert(initial?.description === "look around", "start → description captured");
    assert(initial?.status === "running", "start → status running");
    assert(initial?.toolUseCount === 0, "start → toolUseCount 0");

    updateSubAgentProgress("tool-1", { lastToolName: "Grep", toolUseCount: 1 });
    const mid = getSubAgentProgress("tool-1");
    assert(mid?.lastToolName === "Grep", "update → lastToolName mirrored");
    assert(mid?.toolUseCount === 1, "update → toolUseCount mirrored");
    assert(mid?.agentType === "Explore", "update preserves agentType");

    completeSubAgentProgress("tool-1", {
      reason: "completed",
      durationMs: 1234,
      totalTokens: 99,
      inputTokens: 50,
      outputTokens: 49,
      toolUseCount: 5,
    });
    const done = getSubAgentProgress("tool-1");
    assert(done?.status === "completed", "complete → status completed");
    assert(done?.toolUseCount === 5, "complete → final toolUseCount overrides");
    assert(done?.totalTokens === 99, "complete → totalTokens mirrored");
    assert(done?.durationMs === 1234, "complete → durationMs mirrored");

    completeSubAgentProgress("tool-2", {
      // missing entry → no-op
      reason: "completed",
      durationMs: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
    });
    assert(getSubAgentProgress("tool-2") === undefined, "complete on unknown id is a no-op");

    // max_turns + abort + error mapping
    startSubAgentProgress("tool-3", { agentType: "general-purpose" });
    completeSubAgentProgress("tool-3", {
      reason: "max_turns",
      durationMs: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
    });
    assert(getSubAgentProgress("tool-3")?.status === "max_turns", "reason max_turns → status max_turns");

    startSubAgentProgress("tool-4", { agentType: "general-purpose" });
    completeSubAgentProgress("tool-4", {
      reason: "aborted",
      durationMs: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
    });
    assert(getSubAgentProgress("tool-4")?.status === "aborted", "reason aborted → status aborted");

    startSubAgentProgress("tool-5", { agentType: "general-purpose" });
    completeSubAgentProgress("tool-5", {
      reason: "model_error",
      durationMs: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
    });
    assert(getSubAgentProgress("tool-5")?.status === "error", "reason model_error → status error");

    startSubAgentProgress("tool-6", { agentType: "general-purpose" });
    completeSubAgentProgress("tool-6", {
      reason: "completed",
      durationMs: 1,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolUseCount: 0,
      isError: true,
    });
    assert(getSubAgentProgress("tool-6")?.status === "error", "isError flag → status error even on completed reason");

    // Subscriber received: 4 starts + 1 update + 4 completes (we counted above)
    assert(
      events.some((e) => e.id === "tool-1" && e.status === "running"),
      "subscriber saw running event",
    );
    assert(
      events.some((e) => e.id === "tool-1" && e.status === "completed" && e.tools === 5),
      "subscriber saw completed event with final tools",
    );

    clearSubAgentProgress("tool-1");
    assert(getSubAgentProgress("tool-1") === undefined, "clear drops the entry");
    assert(
      events.some((e) => e.id === "tool-1" && e.status === undefined),
      "subscriber notified of clear with null snapshot",
    );

    clearAllSubAgentProgress();
    assert(getSubAgentProgress("tool-3") === undefined, "clearAll drops every entry");
    unsub();
  }

  console.log("\n[13] /agents command — handler emits a sourced listing");
  {
    const { QueryEngine } = await import("../core/queryEngine.js");

    setAgents([
      {
        agentType: "Explore",
        whenToUse: "code exploration specialist",
        source: "built-in",
        tools: ["Read", "Grep", "Glob"],
        disallowedTools: ["Write", "Edit"],
        getSystemPrompt: () => "explore prompt",
      },
      {
        agentType: "general-purpose",
        whenToUse: "default delegate",
        source: "built-in",
        getSystemPrompt: () => "gp prompt",
      },
      {
        agentType: "code-reviewer",
        whenToUse: "Review staged diffs before commit.",
        source: "project",
        model: "claude-haiku-4.5",
        maxTurns: 10,
        permissionMode: "default",
        filePath: "/tmp/.easy-agent/agents/code-reviewer.md",
        getSystemPrompt: () => "reviewer prompt",
      },
    ]);

    const engine = new QueryEngine({
      model: "test-model",
      toolContext: {
        cwd: process.cwd(),
        sessionId: "test-agents-cmd",
      },
    });

    let infoMessage = "";
    const generator = engine.submitMessage("/agents");
    let next = await generator.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "command" && event.kind === "info") {
        infoMessage = event.message;
      }
      next = await generator.next();
    }

    assert(infoMessage.startsWith("Agents (3 loaded)"), "/agents header counts all agents");
    assert(infoMessage.includes("general-purpose"), "/agents includes general-purpose");
    assert(infoMessage.includes("Explore"), "/agents includes Explore");
    assert(infoMessage.includes("code-reviewer"), "/agents includes custom project agent");
    assert(infoMessage.includes("built-in · tools:"), "/agents tags built-in source");
    assert(infoMessage.includes("project · tools:"), "/agents tags project source");
    assert(infoMessage.includes("tools: Read,Grep,Glob"), "/agents shows tools allow-list");
    assert(infoMessage.includes("disallowed: Write,Edit"), "/agents shows disallowedTools");
    assert(infoMessage.includes("model: claude-haiku-4.5"), "/agents shows model override");
    assert(infoMessage.includes("maxTurns: 10"), "/agents shows maxTurns");

    // Built-in must come BEFORE project in the listing — ordering matters
    // for users scanning by source.
    const idxBuiltIn = infoMessage.indexOf("Explore");
    const idxProject = infoMessage.indexOf("code-reviewer");
    assert(idxBuiltIn < idxProject, "/agents lists built-in before project");

    clearAgents();
  }

  console.log("\n[14] Tool concurrency flags + agentTool isConcurrencySafe");
  {
    const allTools2 = getAllTools();
    const findTool = (n: string) => allTools2.find((t) => t.name === n);

    assert(
      findTool("Agent")?.isConcurrencySafe?.() === true,
      "Agent tool isConcurrencySafe → true (parallel sub-agent fan-out)",
    );
    assert(findTool("Read")?.isConcurrencySafe?.() === true, "Read tool isConcurrencySafe → true");
    assert(findTool("Grep")?.isConcurrencySafe?.() === true, "Grep tool isConcurrencySafe → true");
    assert(findTool("Glob")?.isConcurrencySafe?.() === true, "Glob tool isConcurrencySafe → true");
    // Mutating tools must remain serial.
    const writeUnsafe = findTool("Write")?.isConcurrencySafe?.() ?? false;
    const editUnsafe = findTool("Edit")?.isConcurrencySafe?.() ?? false;
    const bashUnsafe = findTool("Bash")?.isConcurrencySafe?.() ?? false;
    assert(writeUnsafe === false, "Write tool stays not concurrency-safe");
    assert(editUnsafe === false, "Edit tool stays not concurrency-safe");
    assert(bashUnsafe === false, "Bash tool stays not concurrency-safe");
  }

  console.log("\n[15] runTools — parallel batches actually run concurrently");
  {
    // We test the partition/parallel logic of `runTools` by registering
    // a transient probe tool that tracks how many concurrent calls
    // were in flight at peak. If runTools is serial, peak=1; if it's
    // parallel for safe tools, peak == fan-out.
    const { runTools } = await import("../core/agenticLoop.js");
    const { registerMcpTools, clearMcpTools } = await import("../tools/index.js");

    let inflight = 0;
    let peak = 0;
    const probeSafe = {
      name: "ProbeSafe",
      description: "test probe",
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      async call(): Promise<{ content: string }> {
        inflight++;
        if (inflight > peak) peak = inflight;
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { content: "ok" };
      },
      isReadOnly: () => true,
      isEnabled: () => true,
      isConcurrencySafe: () => true,
    };
    let unsafeInflight = 0;
    let unsafePeak = 0;
    const probeUnsafe = {
      name: "ProbeUnsafe",
      description: "test probe",
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      async call(): Promise<{ content: string }> {
        unsafeInflight++;
        if (unsafeInflight > unsafePeak) unsafePeak = unsafeInflight;
        await new Promise((r) => setTimeout(r, 30));
        unsafeInflight--;
        return { content: "ok" };
      },
      isReadOnly: () => false,
      isEnabled: () => true,
      // explicit: not concurrency-safe (serial)
      isConcurrencySafe: () => false,
    };
    // Reuse the MCP tool channel as a generic "extra tools" slot for
    // the probes — keeps test isolation clean (one clearMcpTools()
    // restores the registry to its pristine post-bootstrap state).
    registerMcpTools([probeSafe, probeUnsafe]);
    try {
      // 4 ProbeSafe blocks → should run in parallel (peak >= 2 — and
      // actually peak === 4 if scheduling is healthy).
      const safeBlocks = Array.from({ length: 4 }).map((_, i) => ({
        type: "tool_use" as const,
        id: `safe-${i}`,
        name: "ProbeSafe",
        input: {},
      }));
      const safeStart = Date.now();
      const safeResult = await runTools(
        safeBlocks,
        { cwd: process.cwd(), sessionId: "concurrency-test" },
        { permissionMode: "default", sessionPermissionRules: { allow: ["ProbeSafe", "ProbeUnsafe"], deny: [] } },
      );
      const safeElapsed = Date.now() - safeStart;
      assert(safeResult.executions.length === 4, "all 4 safe blocks executed");
      assert(
        safeResult.executions.every((e, i) => e.toolUseId === `safe-${i}`),
        "executions preserve input order",
      );
      assert(peak >= 2, `peak concurrent ProbeSafe calls >= 2 (got ${peak})`);
      assert(
        safeElapsed < 100,
        `parallel batch finishes well under serial budget (4×30ms=120ms): got ${safeElapsed}ms`,
      );

      // 3 ProbeUnsafe blocks → must serialize (peak === 1).
      const unsafeBlocks = Array.from({ length: 3 }).map((_, i) => ({
        type: "tool_use" as const,
        id: `unsafe-${i}`,
        name: "ProbeUnsafe",
        input: {},
      }));
      await runTools(
        unsafeBlocks,
        { cwd: process.cwd(), sessionId: "concurrency-test" },
        { permissionMode: "default", sessionPermissionRules: { allow: ["ProbeSafe", "ProbeUnsafe"], deny: [] } },
      );
      assert(unsafePeak === 1, `unsafe tools serialized (peak=${unsafePeak})`);

      // Mixed batch: safe, safe, unsafe, safe, safe — should produce
      // three batches: [safe,safe] parallel, [unsafe] serial, [safe,safe]
      // parallel. We don't measure ordering here; just confirm the
      // executions array is in input order and total = 5.
      peak = 0;
      const mixedBlocks = [
        { type: "tool_use" as const, id: "m0", name: "ProbeSafe", input: {} },
        { type: "tool_use" as const, id: "m1", name: "ProbeSafe", input: {} },
        { type: "tool_use" as const, id: "m2", name: "ProbeUnsafe", input: {} },
        { type: "tool_use" as const, id: "m3", name: "ProbeSafe", input: {} },
        { type: "tool_use" as const, id: "m4", name: "ProbeSafe", input: {} },
      ];
      const mixed = await runTools(
        mixedBlocks,
        { cwd: process.cwd(), sessionId: "concurrency-test" },
        { permissionMode: "default", sessionPermissionRules: { allow: ["ProbeSafe", "ProbeUnsafe"], deny: [] } },
      );
      assert(mixed.executions.length === 5, "mixed batch: all 5 executed");
      assert(
        mixed.executions.map((e) => e.toolUseId).join(",") === "m0,m1,m2,m3,m4",
        "mixed batch preserves model-emitted input order across batches",
      );
    } finally {
      // Drop the probe tools so the rest of the test suite (and any
      // downstream consumer of getAllTools()) sees a pristine pool.
      clearMcpTools();
    }
  }

  console.log("\n[16] subAgentProgressStore — turn_usage live token updates");
  {
    const { startSubAgentProgress, updateSubAgentProgress, getSubAgentProgress, clearAllSubAgentProgress } =
      await import("../state/subAgentProgressStore.js");

    clearAllSubAgentProgress();
    startSubAgentProgress("live-tok-1", { agentType: "Explore", description: "x" });
    // Simulate two turn_usage events from runChildAgent:
    updateSubAgentProgress("live-tok-1", {
      inputTokens: 1200,
      outputTokens: 340,
      totalTokens: 1540,
    });
    let live = getSubAgentProgress("live-tok-1");
    assert(live?.totalTokens === 1540, "live totalTokens after first turn");
    assert(live?.inputTokens === 1200, "live inputTokens after first turn");
    assert(live?.outputTokens === 340, "live outputTokens after first turn");
    assert(live?.status === "running", "live token update doesn't flip status");

    updateSubAgentProgress("live-tok-1", {
      inputTokens: 2800,
      outputTokens: 720,
      totalTokens: 3520,
    });
    live = getSubAgentProgress("live-tok-1");
    assert(live?.totalTokens === 3520, "live totalTokens overwritten by second turn");

    clearAllSubAgentProgress();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nAll agents checks passed.\n");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});

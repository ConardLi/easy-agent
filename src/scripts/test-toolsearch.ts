/**
 * Smoke test for ToolSearch — deferred tool loading and discovery.
 *
 *   npm run test:toolsearch
 *
 * Covers the 加餐 A verification checklist that can run offline: mode
 * parsing, deferral rules, request shaping (filter / defer_loading / beta
 * header / <available-deferred-tools>), select + keyword search, message
 * normalization (strip / turn boundary / unavailable), the non-Anthropic
 * <functions> fallback, compaction carry-over and the schema-not-sent hint.
 */
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Tool } from "../tools/Tool.js";
import {
  runToolSearch,
  searchToolsWithKeywords,
  toolSearchOutputToResult,
  toolSearchTool,
} from "../tools/toolSearchTool.js";
import {
  buildSchemaNotSentHint,
  COMPACT_DISCOVERED_TOOLS_KEY,
  extractDiscoveredToolNames,
  getToolSearchMode,
  isDeferredTool,
  isToolSearchEnabled,
  normalizeToolReferencesForAPI,
  prepareToolSearchRequest,
  renderToolReferencesAsText,
  stripDeferLoading,
  TOOL_REFERENCE_TURN_BOUNDARY,
  TOOL_SEARCH_BETA_HEADER,
} from "../utils/toolSearch.js";

let failures = 0;
function assert(cond: unknown, label: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${label}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN_ENV = {
  EASY_AGENT_ENABLE_TOOL_SEARCH: undefined,
  ENABLE_TOOL_SEARCH: undefined,
  EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS: undefined,
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined,
};

function mkTool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description: extra.description ?? `${name} tool`,
    inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    async call() {
      return { content: "ok" };
    },
    isReadOnly: () => true,
    isEnabled: () => true,
    ...extra,
  };
}

const read = mkTool("Read", { searchHint: "read files, images, PDFs, notebooks" });
const bash = mkTool("Bash", { searchHint: "execute shell commands" });
const taskCreate = mkTool("TaskCreate", { shouldDefer: true, searchHint: "create a task in the task list" });
const taskList = mkTool("TaskList", { shouldDefer: true, searchHint: "list all tasks" });
const notebookEdit = mkTool("NotebookEdit", {
  shouldDefer: true,
  searchHint: "edit Jupyter notebook cells (.ipynb)",
  description: "Replace, insert or delete a cell in a notebook file.",
});
const ghIssue = mkTool("mcp__github__create_issue", { isMcp: true, description: "Create a GitHub issue" });
const ghPr = mkTool("mcp__github__list_pull_requests", { isMcp: true, description: "List pull requests" });
const slackSend = mkTool("mcp__slack__send_message", { isMcp: true, description: "Send a message to a channel" });
const pinned = mkTool("mcp__pinned__status", { isMcp: true, alwaysLoad: true });
const pool: Tool[] = [read, bash, taskCreate, taskList, notebookEdit, ghIssue, ghPr, slackSend, pinned, toolSearchTool];

const FIRST_PARTY = { protocol: "anthropic" as const, baseURL: undefined };
const userMsg = (content: MessageParam["content"]): MessageParam => ({ role: "user", content });
const toolSearchResult = (id: string, names: string[]): MessageParam =>
  userMsg([
    {
      type: "tool_result",
      tool_use_id: id,
      content: names.map((n) => ({ type: "tool_reference", tool_name: n })) as never,
    },
  ]);

function main(): void {
  console.log("\n[1] mode parsing");
  withEnv(CLEAN_ENV, () => {
    assert(getToolSearchMode() === "tst", "unset → tst (default on)");
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "true" }, () => assert(getToolSearchMode() === "tst", "true → tst"));
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "false" }, () =>
      assert(getToolSearchMode() === "standard", "false → standard"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto" }, () =>
      assert(getToolSearchMode() === "tst-auto", "auto → tst-auto"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:25" }, () =>
      assert(getToolSearchMode() === "tst-auto", "auto:25 → tst-auto"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:0" }, () => assert(getToolSearchMode() === "tst", "auto:0 → tst"));
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:100" }, () =>
      assert(getToolSearchMode() === "standard", "auto:100 → standard"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:abc" }, () =>
      assert(getToolSearchMode() === "tst-auto", "auto:abc → tst-auto (default 10%)"),
    );
    withEnv({ EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS: "1", EASY_AGENT_ENABLE_TOOL_SEARCH: "true" }, () =>
      assert(getToolSearchMode() === "standard", "kill switch wins over explicit true"),
    );
  });

  console.log("\n[2] deferral rules");
  assert(!isDeferredTool(read) && !isDeferredTool(bash), "Read / Bash not deferred");
  assert(isDeferredTool(taskCreate), "shouldDefer → deferred");
  assert(isDeferredTool(ghIssue), "MCP → deferred");
  assert(!isDeferredTool(pinned), "alwaysLoad MCP → not deferred");
  assert(!isDeferredTool(toolSearchTool), "ToolSearch itself never deferred");
  assert(!isDeferredTool(mkTool("ToolSearch", { shouldDefer: true })), "ToolSearch wins over shouldDefer");

  console.log("\n[3] enablement");
  withEnv(CLEAN_ENV, () => {
    assert(isToolSearchEnabled("claude-sonnet-4-5", pool, FIRST_PARTY), "sonnet + first-party → enabled");
    assert(!isToolSearchEnabled("claude-haiku-4-5", pool, FIRST_PARTY), "haiku → disabled");
    assert(
      !isToolSearchEnabled(
        "claude-sonnet-4-5",
        pool.filter((t) => t.name !== "ToolSearch"),
        FIRST_PARTY,
      ),
      "ToolSearch disallowed → disabled",
    );
    const proxy = { protocol: "anthropic" as const, baseURL: "https://gateway.example.com/v1" };
    assert(!isToolSearchEnabled("claude-sonnet-4-5", pool, proxy), "anthropic via proxy, env unset → disabled");
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "true" }, () =>
      assert(isToolSearchEnabled("claude-sonnet-4-5", pool, proxy), "proxy + explicit true → enabled"),
    );
    assert(
      isToolSearchEnabled("gpt-5.1", pool, { protocol: "openai-chat", baseURL: "https://api.openai.com/v1" }),
      "openai-chat protocol → enabled (client-side fallback, no gateway gate)",
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:100" }, () =>
      assert(!isToolSearchEnabled("claude-sonnet-4-5", pool, FIRST_PARTY), "auto:100 → disabled"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto:0" }, () =>
      assert(isToolSearchEnabled("claude-sonnet-4-5", pool, FIRST_PARTY), "auto:0 → enabled"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto", EASY_AGENT_MAX_CONTEXT_TOKENS: "1000" }, () =>
      assert(isToolSearchEnabled("claude-sonnet-4-5", pool, FIRST_PARTY), "auto with tiny context → above threshold"),
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "auto" }, () =>
      assert(!isToolSearchEnabled("claude-sonnet-4-5", pool, FIRST_PARTY), "auto with 200k context → below threshold"),
    );
  });

  console.log("\n[4] request shaping — first turn");
  withEnv(CLEAN_ENV, () => {
    const first = prepareToolSearchRequest({
      tools: pool,
      messages: [userMsg("hello")],
      model: "claude-sonnet-4-5",
      env: FIRST_PARTY,
    });
    const names = first.tools.map((t) => t.name);
    assert(first.enabled, "enabled");
    assert(
      names.includes("Read") && names.includes("Bash") && names.includes("ToolSearch"),
      "non-deferred + ToolSearch sent",
    );
    assert(names.includes("mcp__pinned__status"), "alwaysLoad MCP sent on turn 1");
    assert(!names.includes("TaskCreate") && !names.includes("mcp__github__create_issue"), "deferred tools NOT sent");
    assert(
      first.tools.every((t) => !t.defer_loading),
      "nothing sent carries defer_loading yet",
    );
    assert(first.betaHeaders.includes(TOOL_SEARCH_BETA_HEADER), "beta header added");
    const firstContent = first.messages[0]!.content as Array<{ type: string; text?: string }>;
    const announcement = firstContent[0]?.text ?? "";
    assert(announcement.startsWith("<available-deferred-tools>"), "announcement merged into first user message");
    assert(
      ["TaskCreate", "TaskList", "NotebookEdit", "mcp__github__create_issue", "mcp__slack__send_message"].every((n) =>
        announcement.includes(`\n${n}\n`),
      ),
      "announcement lists every deferred tool",
    );
    assert(
      !announcement.includes("mcp__pinned__status") && !announcement.includes("\nRead\n"),
      "announcement excludes loaded tools",
    );
    assert(firstContent[1]?.text === "hello", "original user text preserved after announcement");

    console.log("\n[5] request shaping — after ToolSearch");
    const after = prepareToolSearchRequest({
      tools: pool,
      messages: [
        userMsg("hello"),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "select:TaskCreate,TaskList" } }],
        },
        toolSearchResult("t1", ["TaskCreate", "TaskList"]),
      ],
      model: "claude-sonnet-4-5",
      env: FIRST_PARTY,
    });
    const afterNames = after.tools.map((t) => t.name);
    assert(afterNames.includes("TaskCreate") && afterNames.includes("TaskList"), "discovered tools re-included");
    assert(
      after.tools
        .filter((t) => t.defer_loading)
        .map((t) => t.name)
        .sort()
        .join() === "TaskCreate,TaskList",
      "discovered deferred tools carry defer_loading",
    );
    assert(!afterNames.includes("NotebookEdit"), "undiscovered deferred tool still absent");

    console.log("\n[6] request shaping — disabled paths");
    const haiku = prepareToolSearchRequest({
      tools: pool,
      messages: [userMsg("hi")],
      model: "claude-haiku-4-5",
      env: FIRST_PARTY,
    });
    assert(!haiku.enabled, "haiku → disabled");
    assert(!haiku.tools.some((t) => t.name === "ToolSearch"), "ToolSearch removed when disabled");
    assert(
      haiku.tools.some((t) => t.name === "TaskCreate") &&
        haiku.tools.some((t) => t.name === "mcp__github__create_issue"),
      "all tools sent inline when disabled",
    );
    assert(
      haiku.betaHeaders.length === 0 && typeof haiku.messages[0]!.content === "string",
      "no beta header / no announcement when disabled",
    );

    const noDeferred = prepareToolSearchRequest({
      tools: [read, bash, toolSearchTool],
      messages: [userMsg("hi")],
      model: "claude-sonnet-4-5",
      env: FIRST_PARTY,
    });
    assert(
      !noDeferred.enabled && !noDeferred.tools.some((t) => t.name === "ToolSearch"),
      "empty pool, no pending MCP → disabled",
    );
    const pending = prepareToolSearchRequest({
      tools: [read, bash, toolSearchTool],
      messages: [userMsg("hi")],
      model: "claude-sonnet-4-5",
      env: FIRST_PARTY,
      hasPendingMcpServers: true,
    });
    assert(
      pending.enabled && pending.tools.some((t) => t.name === "ToolSearch"),
      "empty pool but pending MCP → ToolSearch kept",
    );
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "false" }, () => {
      const off = prepareToolSearchRequest({
        tools: pool,
        messages: [userMsg("hi")],
        model: "claude-sonnet-4-5",
        env: FIRST_PARTY,
      });
      assert(
        !off.enabled && off.tools.length === pool.length - 1,
        "EASY_AGENT_ENABLE_TOOL_SEARCH=false → standard, all but ToolSearch",
      );
    });
  });

  console.log("\n[7] select queries");
  const sel = runToolSearch("select:TaskCreate,TaskList", 5, pool);
  assert(sel.matches.join() === "TaskCreate,TaskList", "select two deferred tools");
  assert(sel.total_deferred_tools === 6, "total_deferred_tools counts the deferred pool (alwaysLoad excluded)");
  assert(
    runToolSearch("select:Read", 5, pool).matches.join() === "Read",
    "select already-loaded tool → harmless no-op",
  );
  assert(
    runToolSearch("select:TaskGet,NoSuchTool,TaskList", 5, pool).matches.join() === "TaskList",
    "partial select returns found subset",
  );
  assert(runToolSearch("SELECT:tasklist", 5, pool).matches.join() === "TaskList", "select is case-insensitive");
  const miss = runToolSearch("select:Nope", 5, pool, ["slow-server"]);
  assert(
    miss.matches.length === 0 && miss.pending_mcp_servers?.[0] === "slow-server",
    "empty select carries pending servers",
  );
  const missText = toolSearchOutputToResult(miss).content as string;
  assert(
    missText.startsWith("No matching deferred tools found") && missText.includes("slow-server"),
    "empty result text mentions pending server",
  );
  const hit = toolSearchOutputToResult(sel).content as Array<{ type: string; tool_name: string }>;
  assert(hit.length === 2 && hit.every((b) => b.type === "tool_reference"), "hit → tool_reference blocks only");

  console.log("\n[8] keyword search");
  const deferred = pool.filter(isDeferredTool);
  assert(
    searchToolsWithKeywords("jupyter", deferred, pool, 5)[0] === "NotebookEdit",
    "searchHint hit: jupyter → NotebookEdit",
  );
  assert(
    searchToolsWithKeywords("mcp__github", deferred, pool, 5).sort().join() ===
      "mcp__github__create_issue,mcp__github__list_pull_requests",
    "mcp__ prefix → whole server",
  );
  assert(
    searchToolsWithKeywords("+slack send", deferred, pool, 5).join() === "mcp__slack__send_message",
    "+required term filters to slack",
  );
  const github = searchToolsWithKeywords("github issue", deferred, pool, 5);
  assert(
    github[0] === "mcp__github__create_issue" && github[1] === "mcp__github__list_pull_requests",
    "scoring: two hits outrank one",
  );
  assert(
    searchToolsWithKeywords("taskcreate", deferred, pool, 5).join() === "TaskCreate",
    "exact name fast path (case-insensitive)",
  );
  assert(searchToolsWithKeywords("task", deferred, pool, 1).length === 1, "max_results honoured");
  assert(searchToolsWithKeywords("zzzz", deferred, pool, 5).length === 0, "no hit → empty");

  console.log("\n[9] message normalization");
  const history: MessageParam[] = [userMsg("hi"), toolSearchResult("t1", ["TaskCreate", "mcp__gone__tool"])];
  const off = normalizeToolReferencesForAPI(history, { toolSearchEnabled: false, availableToolNames: new Set() });
  const offBlock = (off[1]!.content as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!;
  assert(
    offBlock.content.length === 1 &&
      offBlock.content[0]!.type === "text" &&
      offBlock.content[0]!.text!.includes("not enabled"),
    "disabled → refs stripped, placeholder text",
  );
  const on = normalizeToolReferencesForAPI(history, {
    toolSearchEnabled: true,
    availableToolNames: new Set(["TaskCreate"]),
  });
  const onContent = on[1]!.content as Array<{
    type: string;
    text?: string;
    content?: Array<{ type: string; tool_name?: string }>;
  }>;
  assert(
    onContent[0]!.content!.length === 1 && onContent[0]!.content![0]!.tool_name === "TaskCreate",
    "enabled → only unavailable ref stripped",
  );
  assert(
    onContent[1]?.type === "text" && onContent[1].text === TOOL_REFERENCE_TURN_BOUNDARY,
    "enabled → 'Tool loaded.' sibling appended",
  );
  const twice = normalizeToolReferencesForAPI(on, {
    toolSearchEnabled: true,
    availableToolNames: new Set(["TaskCreate"]),
  });
  assert((twice[1]!.content as unknown[]).length === 2, "turn boundary is idempotent");
  assert(on[0] === history[0], "messages without refs untouched");

  console.log("\n[10] non-Anthropic fallback");
  const apiTools = [
    { name: "TaskCreate", description: "Create", input_schema: taskCreate.inputSchema, defer_loading: true },
  ];
  const rendered = renderToolReferencesAsText([toolSearchResult("t1", ["TaskCreate", "Ghost"])], apiTools);
  const rBlock = (rendered[0]!.content as Array<{ content: Array<{ type: string; text: string }> }>)[0]!;
  assert(rBlock.content.length === 1 && rBlock.content[0]!.type === "text", "refs collapsed to one text block");
  assert(
    rBlock.content[0]!.text.startsWith("<functions>") &&
      rBlock.content[0]!.text.includes('"name":"TaskCreate"') &&
      rBlock.content[0]!.text.includes('"parameters"'),
    "schema rendered as <function> line",
  );
  assert(
    rBlock.content[0]!.text.includes('"name":"Ghost"') && rBlock.content[0]!.text.includes("no longer available"),
    "unknown ref rendered as unavailable",
  );
  assert(
    stripDeferLoading(apiTools).every((t) => !("defer_loading" in t)),
    "defer_loading stripped for providers",
  );

  console.log("\n[11] compaction carry-over");
  const compacted: MessageParam[] = [
    userMsg("summary…"),
    {
      role: "assistant",
      content: `[CompactBoundary] type=auto messages=40 ${COMPACT_DISCOVERED_TOOLS_KEY}=TaskCreate,mcp__github__create_issue`,
    },
    userMsg("continue"),
  ];
  const carried = extractDiscoveredToolNames(compacted);
  assert(
    carried.has("TaskCreate") && carried.has("mcp__github__create_issue") && carried.size === 2,
    "boundary marker restores discovered set",
  );
  withEnv(CLEAN_ENV, () => {
    const post = prepareToolSearchRequest({
      tools: pool,
      messages: compacted,
      model: "claude-sonnet-4-5",
      env: FIRST_PARTY,
    });
    assert(
      post.tools.some((t) => t.name === "TaskCreate" && t.defer_loading),
      "post-compact request still sends carried tool",
    );
  });

  console.log("\n[12] schema-not-sent hint");
  withEnv(CLEAN_ENV, () => {
    const hint = buildSchemaNotSentHint(taskCreate, [userMsg("hi")], pool);
    assert(hint !== null && hint.includes('ToolSearch("select:TaskCreate")'), "undiscovered deferred tool → hint");
    assert(
      buildSchemaNotSentHint(taskCreate, [userMsg("hi"), toolSearchResult("t1", ["TaskCreate"])], pool) === null,
      "discovered → no hint",
    );
    assert(buildSchemaNotSentHint(read, [userMsg("hi")], pool) === null, "non-deferred → no hint");
    assert(buildSchemaNotSentHint(taskCreate, [userMsg("hi")], [read]) === null, "ToolSearch unavailable → no hint");
    withEnv({ EASY_AGENT_ENABLE_TOOL_SEARCH: "false" }, () =>
      assert(buildSchemaNotSentHint(taskCreate, [userMsg("hi")], pool) === null, "standard mode → no hint"),
    );
  });

  console.log(failures === 0 ? "\nAll ToolSearch checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

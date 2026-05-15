/**
 * Step 20 - Background Agent and Worktree isolation
 *
 * Goal:
 * - let Agent run in the background with `run_in_background`
 * - write background progress into a tail-able `.output` JSONL file
 * - notify the parent conversation with `<task-notification>`
 * - optionally run the child agent inside a git worktree
 * - keep dirty worktrees and auto-remove clean worktrees
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------------
// 1. Async agent store
// -----------------------------------------------------------------------------

const asyncAgents = new Map();

export function registerAsyncAgent(init) {
  if (asyncAgents.has(init.agentId)) {
    throw new Error("Async agent already exists: " + init.agentId);
  }
  const entry = {
    agentId: init.agentId,
    agentType: init.agentType,
    description: init.description,
    prompt: init.prompt,
    outputFile: init.outputFile,
    isolated: Boolean(init.worktreePath),
    worktreePath: init.worktreePath,
    worktreeBranch: init.worktreeBranch,
    startedAt: new Date().toISOString(),
    status: "running",
    abortController: new AbortController(),
    toolUseCount: 0,
  };
  asyncAgents.set(entry.agentId, entry);
  return entry;
}

export function updateAsyncAgentProgress(agentId, patch) {
  const cur = asyncAgents.get(agentId);
  if (!cur || cur.status !== "running") return;
  asyncAgents.set(agentId, { ...cur, ...patch });
}

export function completeAsyncAgent(agentId, result, extra = {}) {
  const cur = asyncAgents.get(agentId);
  if (!cur) return;
  asyncAgents.set(agentId, {
    ...cur,
    status: "completed",
    finalText: result.finalText,
    durationMs: result.totalDurationMs,
    totalTokens: result.totalTokens,
    toolUseCount: result.totalToolUseCount,
    reason: result.reason,
    ...extra,
  });
}

export function failAsyncAgent(agentId, error, durationMs) {
  const cur = asyncAgents.get(agentId);
  if (!cur) return;
  asyncAgents.set(agentId, {
    ...cur,
    status: "failed",
    error,
    durationMs,
    reason: "model_error",
  });
}

export function killAsyncAgent(agentId) {
  const cur = asyncAgents.get(agentId);
  if (!cur || cur.status !== "running") return false;
  cur.abortController.abort();
  asyncAgents.set(agentId, { ...cur, status: "killed", reason: "aborted" });
  return true;
}

export function getAsyncAgent(agentId) {
  return asyncAgents.get(agentId);
}

export function getAllAsyncAgents() {
  return [...asyncAgents.values()];
}

export function clearAllAsyncAgents() {
  asyncAgents.clear();
}

// -----------------------------------------------------------------------------
// 2. Notification queue
// -----------------------------------------------------------------------------

const pendingNotifications = [];

export function enqueuePendingNotification(notification) {
  pendingNotifications.push({ ...notification, enqueuedAt: Date.now() });
}

export function drainPendingNotifications() {
  return pendingNotifications.splice(0, pendingNotifications.length);
}

export function formatTaskNotification(parts) {
  const lines = ["<task-notification>"];
  lines.push("  <task_id>" + parts.agentId + "</task_id>");
  lines.push("  <agent_type>" + parts.agentType + "</agent_type>");
  lines.push("  <status>" + parts.status + "</status>");
  if (parts.description) lines.push("  <description>" + parts.description + "</description>");
  lines.push("  <output_file>" + parts.outputFile + "</output_file>");
  if (parts.finalText) {
    lines.push("  <result>");
    lines.push(parts.finalText);
    lines.push("  </result>");
  }
  if (parts.error) lines.push("  <error>" + parts.error + "</error>");
  if (parts.totalTokens !== undefined || parts.toolUseCount !== undefined) {
    lines.push(
      "  <usage>" +
        [
          parts.totalTokens !== undefined ? "tokens=" + parts.totalTokens : "",
          parts.toolUseCount !== undefined ? "tools=" + parts.toolUseCount : "",
          parts.durationMs !== undefined ? "duration_ms=" + parts.durationMs : "",
        ].filter(Boolean).join(" ") +
        "</usage>",
    );
  }
  if (parts.worktreePath) {
    lines.push("  <worktree_path>" + parts.worktreePath + "</worktree_path>");
    if (parts.worktreeBranch) {
      lines.push("  <worktree_branch>" + parts.worktreeBranch + "</worktree_branch>");
    }
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// 3. Output files
// -----------------------------------------------------------------------------

function encodeSegment(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/g, "-");
}

export function getProjectsRoot() {
  if (process.env.EASY_AGENT_PROJECTS_ROOT) {
    return process.env.EASY_AGENT_PROJECTS_ROOT;
  }
  return path.join(os.homedir(), ".easy-agent", "projects");
}

export function getTaskOutputPath(sessionId, agentId) {
  return path.join(
    getProjectsRoot(),
    encodeSegment(sessionId || "default"),
    "tasks",
    encodeSegment(agentId) + ".output",
  );
}

export async function ensureTaskOutputFile(sessionId, agentId) {
  const filePath = getTaskOutputPath(sessionId, agentId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a");
  await handle.close();
  return filePath;
}

export async function appendTaskOutput(filePath, event) {
  const record = { timestamp: new Date().toISOString(), ...event };
  await fs.appendFile(filePath, JSON.stringify(record) + "\n").catch(() => {});
}

// -----------------------------------------------------------------------------
// 4. Git worktree isolation
// -----------------------------------------------------------------------------

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 127,
      stdout: error?.stdout || "",
      stderr: error?.stderr || error.message || String(error),
    };
  }
}

export async function findGitRoot(cwd) {
  let current = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function flattenSlug(slug) {
  return String(slug).replaceAll("/", "+");
}

export function worktreeBranchName(slug) {
  return "worktree-" + flattenSlug(slug);
}

export function worktreePathFor(repoRoot, slug) {
  return path.join(repoRoot, ".easy-agent", "worktrees", flattenSlug(slug));
}

export async function createAgentWorktree(slug, cwd) {
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) throw new Error("Not inside a git repository: " + cwd);

  const head = await git(["rev-parse", "HEAD"], gitRoot);
  if (head.code !== 0) throw new Error("Cannot read HEAD: " + head.stderr);

  const worktreePath = worktreePathFor(gitRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const add = await git(["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"], gitRoot);
  if (add.code !== 0) throw new Error("git worktree add failed: " + add.stderr);

  return {
    gitRoot,
    worktreePath,
    worktreeBranch,
    headCommit: head.stdout.trim(),
  };
}

export async function hasWorktreeChanges(worktreePath, headCommit) {
  const status = await git(["status", "--porcelain"], worktreePath);
  if (status.code !== 0) return true;
  if (status.stdout.trim()) return true;

  const revList = await git(["rev-list", "--count", headCommit + "..HEAD"], worktreePath);
  if (revList.code !== 0) return true;
  return Number.parseInt(revList.stdout.trim(), 10) > 0;
}

export async function removeAgentWorktree(info) {
  const remove = await git(["worktree", "remove", "--force", info.worktreePath], info.gitRoot);
  const branch = await git(["branch", "-D", info.worktreeBranch], info.gitRoot);
  return {
    ok: remove.code === 0 && branch.code === 0,
    error: [remove.stderr, branch.stderr].filter(Boolean).join("; "),
  };
}

async function cleanupWorktreeIfNeeded(info) {
  if (!info) return {};
  const dirty = await hasWorktreeChanges(info.worktreePath, info.headCommit).catch(() => true);
  if (dirty) {
    return { worktreePath: info.worktreePath, worktreeBranch: info.worktreeBranch };
  }
  await removeAgentWorktree(info);
  return {};
}

// -----------------------------------------------------------------------------
// 5. Background lifecycle
// -----------------------------------------------------------------------------

export async function mockRunChildAgent(params) {
  if (params.abortSignal?.aborted) {
    return emptyAgentResult(params.agentDefinition.agentType, "aborted");
  }

  params.onProgress?.({ type: "text", text: "started child work" });
  params.onProgress?.({ type: "tool_use_start", toolName: "Read" });
  params.onProgress?.({ type: "tool_use_done", toolName: "Read", isError: false });
  params.onProgress?.({
    type: "turn_usage",
    cumulativeUsage: { input_tokens: 100, output_tokens: 30 },
    turnCount: 1,
  });

  return {
    agentType: params.agentDefinition.agentType,
    finalText:
      "Finished in " +
      (params.cwdOverride || params.parentToolContext?.cwd || process.cwd()),
    messages: [],
    totalToolUseCount: 1,
    totalDurationMs: 20,
    totalTokens: 130,
    inputTokens: 100,
    outputTokens: 30,
    turnCount: 1,
    reason: "completed",
  };
}

function emptyAgentResult(agentType, reason) {
  return {
    agentType,
    finalText: "",
    messages: [],
    totalToolUseCount: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
    reason,
  };
}

export async function runAsyncAgentLifecycle(params) {
  const { entry } = params;
  const startedAt = Date.now();

  await appendTaskOutput(entry.outputFile, {
    type: "started",
    agentType: entry.agentType,
    description: entry.description,
    prompt: params.prompt,
  });

  try {
    const result = await params.runChildAgent({
      agentDefinition: params.agentDefinition,
      prompt: params.prompt,
      availableTools: params.availableTools,
      model: params.model,
      parentToolContext: params.parentToolContext,
      abortSignal: entry.abortController.signal,
      cwdOverride: params.worktreeInfo?.worktreePath,
      onProgress: (event) => {
        if (event.type === "text") {
          void appendTaskOutput(entry.outputFile, { type: "text", text: event.text });
        }
        if (event.type === "tool_use_start") {
          void appendTaskOutput(entry.outputFile, { type: "tool_use", toolName: event.toolName });
          updateAsyncAgentProgress(entry.agentId, { lastToolName: event.toolName });
        }
        if (event.type === "tool_use_done") {
          entry.toolUseCount += 1;
          void appendTaskOutput(entry.outputFile, {
            type: "tool_result",
            toolName: event.toolName,
            isError: event.isError === true,
          });
          updateAsyncAgentProgress(entry.agentId, {
            toolUseCount: entry.toolUseCount,
            lastToolName: event.toolName,
          });
        }
        if (event.type === "turn_usage") {
          const usage = event.cumulativeUsage;
          const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
          void appendTaskOutput(entry.outputFile, {
            type: "turn_usage",
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            totalTokens,
            turn: event.turnCount,
          });
          updateAsyncAgentProgress(entry.agentId, { totalTokens, turnCount: event.turnCount });
        }
      },
    });

    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);
    const durationMs = Date.now() - startedAt;

    await appendTaskOutput(entry.outputFile, {
      type: "completed",
      reason: result.reason,
      finalText: result.finalText,
      durationMs,
      totalTokens: result.totalTokens,
      toolUseCount: result.totalToolUseCount,
    });

    completeAsyncAgent(entry.agentId, result, worktreeFinal);
    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: result.reason === "aborted" ? "killed" : "completed",
        description: entry.description,
        outputFile: entry.outputFile,
        finalText: result.finalText,
        durationMs,
        totalTokens: result.totalTokens,
        toolUseCount: result.totalToolUseCount,
        ...worktreeFinal,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const worktreeFinal = await cleanupWorktreeIfNeeded(params.worktreeInfo);
    const durationMs = Date.now() - startedAt;

    await appendTaskOutput(entry.outputFile, { type: "failed", error: message, durationMs });
    failAsyncAgent(entry.agentId, message, durationMs);
    enqueuePendingNotification({
      mode: "task-notification",
      text: formatTaskNotification({
        agentId: entry.agentId,
        agentType: entry.agentType,
        status: "failed",
        description: entry.description,
        outputFile: entry.outputFile,
        error: message,
        durationMs,
        ...worktreeFinal,
      }),
    });
  }
}

// -----------------------------------------------------------------------------
// 6. Agent tool upgrade
// -----------------------------------------------------------------------------

function shortId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function defaultFindAgent(agentType) {
  return {
    agentType,
    whenToUse: "demo agent",
    source: "built-in",
    getSystemPrompt: () => "You are a demo child agent.",
  };
}

export function createStage20AgentTool({
  findAgent = defaultFindAgent,
  getAllTools = async () => [],
  runChildAgent = mockRunChildAgent,
  runAsyncLifecycle = runAsyncAgentLifecycle,
  defaultModel = "claude-sonnet-4-5",
} = {}) {
  return {
    name: "Agent",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        subagent_type: { type: "string" },
        model: { type: "string" },
        run_in_background: { type: "boolean" },
        isolation: { type: "string", enum: ["none", "worktree"] },
      },
      required: ["prompt", "description"],
      additionalProperties: false,
    },

    async call(input, context = {}) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const description = typeof input.description === "string" ? input.description : "";
      const agentType = input.subagent_type || "general-purpose";
      if (!prompt) return { content: "Error: prompt is required.", isError: true };

      const agent = findAgent(agentType);
      if (!agent) return { content: "Error: unknown sub-agent: " + agentType, isError: true };

      const effectiveIsolation = input.isolation || agent.isolation || "none";
      let worktreeInfo;
      let isolationWarning = "";

      if (effectiveIsolation === "worktree") {
        try {
          worktreeInfo = await createAgentWorktree("agent-" + agentType + "-" + shortId(), context.cwd);
        } catch (error) {
          isolationWarning =
            "Worktree isolation requested but unavailable: " +
            (error instanceof Error ? error.message : String(error));
        }
      }

      if (input.run_in_background === true) {
        const agentId = shortId();
        const outputFile = await ensureTaskOutputFile(context.sessionId || "default", agentId);
        const entry = registerAsyncAgent({
          agentId,
          agentType,
          description,
          prompt,
          outputFile,
          worktreePath: worktreeInfo?.worktreePath,
          worktreeBranch: worktreeInfo?.worktreeBranch,
        });

        void runAsyncLifecycle({
          entry,
          agentDefinition: agent,
          prompt,
          availableTools: await getAllTools(),
          model: input.model || agent.model || context.defaultModel || defaultModel,
          parentToolContext: context,
          worktreeInfo,
          runChildAgent,
        });

        return {
          content: [
            "Sub-agent '" + agentType + "' launched in the BACKGROUND.",
            "agent_id: " + agentId,
            "output_file: " + outputFile,
            worktreeInfo
              ? "worktree: " + worktreeInfo.worktreePath + " (branch: " + worktreeInfo.worktreeBranch + ")"
              : "",
            isolationWarning ? "warning: " + isolationWarning : "",
            "",
            "<async_launched>",
            "  <agent_id>" + agentId + "</agent_id>",
            "  <output_file>" + outputFile + "</output_file>",
            worktreeInfo ? "  <worktree_path>" + worktreeInfo.worktreePath + "</worktree_path>" : "",
            "</async_launched>",
          ].filter(Boolean).join("\n"),
        };
      }

      const result = await runChildAgent({
        agentDefinition: agent,
        prompt,
        availableTools: await getAllTools(),
        model: input.model || agent.model || context.defaultModel || defaultModel,
        parentToolContext: context,
        cwdOverride: worktreeInfo?.worktreePath,
      });

      const worktreeFinal = await cleanupWorktreeIfNeeded(worktreeInfo);
      return {
        content: [
          "Sub-agent '" + agentType + "' completed.",
          result.finalText,
          isolationWarning ? "warning: " + isolationWarning : "",
          worktreeFinal.worktreePath ? "worktree: " + worktreeFinal.worktreePath : "",
        ].filter(Boolean).join("\n"),
      };
    },
  };
}

// -----------------------------------------------------------------------------
// 7. Demo
// -----------------------------------------------------------------------------

export async function demoStep20(cwd = process.cwd()) {
  clearAllAsyncAgents();
  drainPendingNotifications();
  process.env.EASY_AGENT_PROJECTS_ROOT ||= path.join(os.tmpdir(), "easy-agent-step20-demo");

  const agentTool = createStage20AgentTool({
    getAllTools: async () => [{ name: "Read", description: "Read files" }],
  });

  const launch = await agentTool.call(
    {
      prompt: "Review the codebase in the background.",
      description: "Background review",
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    { cwd, sessionId: "demo-session", defaultModel: "demo-model" },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  return {
    launch,
    agents: getAllAsyncAgents(),
    notifications: drainPendingNotifications(),
  };
}

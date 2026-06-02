#!/usr/bin/env tsx
/**
 * Stage 22 verification script — exercise the Hooks Lifecycle System
 * WITHOUT touching the LLM.
 *
 * Coverage:
 *   [1]  Settings normalize — malformed entries, type field, timeout default,
 *                              empty arrays
 *   [2]  Settings merge     — user + project concat with the right order
 *   [3]  findMatchingHooks  — exact, "*", undefined matcher, regex / pipe
 *   [4]  Executor           — bash spawn, stdin payload, env var,
 *                              exit 0 / exit 2 / non-zero plain text paths
 *   [5]  Executor           — JSON output decode (continue / decision /
 *                              permissionDecision / additionalContext)
 *   [6]  Executor           — timeout, abort signal, missing command
 *   [7]  Aggregator         — precedence (deny > ask > allow),
 *                              concatenation of additionalContext + sysMessage,
 *                              first-blockingError-wins
 *   [8]  Per-event runners  — round-trip through settings.json:
 *                              PreToolUse / PostToolUse /
 *                              UserPromptSubmit / SessionStart /
 *                              Stop / SubagentStop
 *   [9]  Master kill-switch — EASY_AGENT_DISABLE_HOOKS
 *
 * Usage:
 *   cd easy-agent
 *   npx tsx src/scripts/test-stage22.ts
 *
 * Tests stub HOME to a temp dir so written `~/.easy-agent/settings.json`
 * never escapes the sandbox. Exits non-zero on any assertion failure.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  executeHookCommand,
} from "../hooks/executor.js";
import {
  findMatchingHooks,
  hasHookForEvent,
  hooksGloballyDisabled,
  loadHooksSettings,
} from "../hooks/settings.js";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runSessionStartHooks,
  runStopHooks,
  runSubagentStopHooks,
  runUserPromptSubmitHooks,
  _resetHooksSettingsCache,
} from "../hooks/runHooks.js";
import type { HookResult, HooksSettings } from "../hooks/types.js";

// ─── Test plumbing ──────────────────────────────────────────────────

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

/**
 * Run `fn` with a temp HOME *and* a temp CWD so every hooks operation
 * is fully sandboxed:
 *
 *   - the user-scope settings.json goes under `<tmpHome>/.easy-agent/`
 *   - the project-scope settings.json (which the loader pulls from
 *     `cwd/.easy-agent/`) goes under `<tmpCwd>/.easy-agent/`
 *
 * We pass `tmpCwd` to every `run*Hooks` call (the runner takes cwd as a
 * parameter), so the test never reads the developer's real
 * `easy-agent/.easy-agent/settings.json` — that file is for demo /
 * dogfooding purposes and would otherwise concatenate its hooks into
 * the test outcomes.
 *
 * Cleanup is unconditional so a failing assertion doesn't leak
 * directories into the developer's real ~/.
 */
async function withTempHome(
  fn: (tmpHome: string, tmpCwd: string) => Promise<void>,
): Promise<void> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "stage22-home-"));
  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "stage22-cwd-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  try {
    await fn(tmpHome, tmpCwd);
  } finally {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpCwd, { recursive: true, force: true });
    _resetHooksSettingsCache();
  }
}

async function writeUserSettings(home: string, hooks: unknown): Promise<void> {
  const dir = path.join(home, ".easy-agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ hooks }, null, 2));
}

async function writeProjectSettings(cwd: string, hooks: unknown): Promise<void> {
  const dir = path.join(cwd, ".easy-agent");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ hooks }, null, 2));
}

async function main(): Promise<void> {
  // ─── [1] Settings normalize ────────────────────────────────────
  console.log("\n[1] settings normalize — malformed entries are filtered");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "echo hi", timeout: 5 },
            { type: "command", command: "" }, // empty command → dropped
            { type: "command" }, // missing command → dropped
            { type: "prompt", prompt: "ignored" }, // unsupported type → dropped
            { command: "echo defaults" }, // type defaults to "command"
          ],
        },
        {
          // missing `hooks` array entirely → whole group dropped
          matcher: "Edit",
        },
        {
          hooks: [], // empty hooks → whole group dropped
        },
      ],
      // Unknown event name → dropped silently
      UnknownEvent: [{ hooks: [{ type: "command", command: "x" }] }],
    });

    const settings = await loadHooksSettings(cwd);
    const pre = settings.PreToolUse;
    assert(Array.isArray(pre) && pre.length === 1, "1 valid matcher group survives normalization");
    assert(pre?.[0]?.hooks.length === 2, "2 valid hook commands survive within the group");
    assert(
      pre?.[0]?.hooks[0]?.timeout === 5,
      "explicit timeout preserved",
    );
    assert(
      pre?.[0]?.hooks[1]?.timeout === 60,
      "default timeout = 60s applied when omitted",
    );
    assert(
      settings.PostToolUse === undefined,
      "events absent from disk stay absent",
    );
    assert(
      (settings as Record<string, unknown>).UnknownEvent === undefined,
      "unknown event names filtered out",
    );
  });

  // ─── [2] Settings merge — user + project ───────────────────────
  console.log("\n[2] settings merge — user first, project appended");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo user" }] },
      ],
    });
    await writeProjectSettings(cwd, {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo project" }] },
      ],
    });
    _resetHooksSettingsCache();
    // Stage 25: project hooks are trust-gated (they run shell commands), so
    // they only merge once the folder is trusted. Trust it to verify the
    // merge contract; the untrusted path is covered in smoke-config.ts.
    const { trustProject, resetGlobalStateCache } = await import(
      "../config/globalState.js"
    );
    resetGlobalStateCache();
    await trustProject(cwd);
    const settings = await loadHooksSettings(cwd);
    const groups = settings.UserPromptSubmit ?? [];
    assert(groups.length === 2, "both user + project groups concatenate");
    assert(
      groups[0]?.hooks[0]?.command === "echo user",
      "user group comes first",
    );
    assert(
      groups[1]?.hooks[0]?.command === "echo project",
      "project group comes second",
    );
  });

  // ─── [3] findMatchingHooks ─────────────────────────────────────
  console.log("\n[3] findMatchingHooks — matcher syntax");

  const settings: HooksSettings = {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "exact" }] },
      { matcher: "*", hooks: [{ type: "command", command: "any" }] },
      { matcher: "Edit|Write", hooks: [{ type: "command", command: "edit-or-write" }] },
      { hooks: [{ type: "command", command: "no-matcher" }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: "prompt-1" }] },
    ],
  };

  const bashHooks = findMatchingHooks(settings, "PreToolUse", "Bash");
  assert(
    bashHooks.map((h) => h.command).join(",") === "exact,any,no-matcher",
    "Bash matches exact + wildcard + no-matcher (NOT the regex group)",
  );

  const editHooks = findMatchingHooks(settings, "PreToolUse", "Edit");
  assert(
    editHooks.map((h) => h.command).join(",") === "any,edit-or-write,no-matcher",
    "Edit matches wildcard + regex pipe + no-matcher",
  );

  const writeHooks = findMatchingHooks(settings, "PreToolUse", "Write");
  assert(
    writeHooks.map((h) => h.command).join(",") === "any,edit-or-write,no-matcher",
    "Write matches wildcard + regex pipe + no-matcher (case-sensitive)",
  );

  const noFieldEvent = findMatchingHooks(settings, "UserPromptSubmit", undefined);
  assert(
    noFieldEvent.length === 1 && noFieldEvent[0]?.command === "prompt-1",
    "events without a match field fire all groups",
  );

  assert(
    findMatchingHooks(settings, "PostToolUse", "Bash").length === 0,
    "events with no configured hooks return empty",
  );

  assert(
    hasHookForEvent(settings, "PreToolUse", "Bash") === true,
    "hasHookForEvent true for configured tool",
  );
  assert(
    hasHookForEvent(settings, "Stop") === false,
    "hasHookForEvent false for unconfigured event",
  );

  // ─── [4] Executor — basic spawn + capture ──────────────────────
  console.log("\n[4] executor — spawn, stdin payload, env var");

  await withTempHome(async (_home, cwd) => {
    const result = await executeHookCommand({
      hook: { type: "command", command: "cat" },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:test",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "tu-1",
      },
      cwd,
    });
    assert(result.outcome === "success", "cat hook succeeds (exit 0)");
    assert(
      result.stdout.includes('"tool_name":"Bash"'),
      "cat echoes the JSON hook input from stdin",
    );

    // env var EASY_AGENT_PROJECT_DIR is exposed
    const envResult = await executeHookCommand({
      hook: { type: "command", command: "printenv EASY_AGENT_PROJECT_DIR" },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:env",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "x",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
    });
    assert(
      envResult.stdout.trim() === cwd,
      "EASY_AGENT_PROJECT_DIR env var matches cwd",
    );
  });

  // ─── [4b] Executor — exit code 0 plain text path ───────────────
  console.log("\n[4b] executor — plain stdout becomes additionalContext for some events");

  {
    const cwd = process.cwd();
    const r1 = await executeHookCommand({
      hook: { type: "command", command: "echo from-stdout" },
      hookEvent: "UserPromptSubmit",
      hookName: "UserPromptSubmit:test",
      hookInput: {
        hook_event_name: "UserPromptSubmit",
        session_id: "",
        cwd,
        prompt: "hi",
      },
      cwd,
    });
    assert(
      r1.additionalContext === "from-stdout",
      "UserPromptSubmit + plain stdout → additionalContext",
    );

    const r2 = await executeHookCommand({
      hook: { type: "command", command: "echo from-stdout" },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:test",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
    });
    assert(
      r2.additionalContext === undefined,
      "PreToolUse plain stdout does NOT become additionalContext (source parity)",
    );
  }

  // ─── [4c] Executor — exit code 2 blocking path ─────────────────
  console.log("\n[4c] executor — exit 2 → blocking error from stderr");

  {
    const cwd = process.cwd();
    const r = await executeHookCommand({
      hook: {
        type: "command",
        command: ">&2 echo 'forbidden by hook'; exit 2",
      },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:guard",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "x",
      },
      cwd,
    });
    assert(r.outcome === "blocking", "exit 2 → outcome=blocking");
    assert(r.permissionBehavior === "deny", "exit 2 → permissionBehavior=deny");
    assert(
      r.blockingError === "forbidden by hook",
      "stderr surfaces as blockingError",
    );
  }

  // ─── [4d] Executor — exit code 1 non-blocking error ────────────
  console.log("\n[4d] executor — exit 1 → non_blocking_error (loop continues)");

  {
    const cwd = process.cwd();
    const r = await executeHookCommand({
      hook: { type: "command", command: ">&2 echo oops; exit 1" },
      hookEvent: "PostToolUse",
      hookName: "PostToolUse:warn",
      hookInput: {
        hook_event_name: "PostToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_response: null,
        tool_use_id: "x",
      },
      cwd,
    });
    assert(
      r.outcome === "non_blocking_error",
      "exit 1 + no JSON → non_blocking_error",
    );
    assert(
      r.blockingError === undefined,
      "non-blocking error does NOT set blockingError",
    );
    assert(r.stderr.includes("oops"), "stderr preserved");
  }

  // ─── [5] Executor — JSON output decoding ───────────────────────
  console.log("\n[5] executor — JSON output decode");

  {
    const cwd = process.cwd();
    // (a) decision: "block" with reason
    const denied = await executeHookCommand({
      hook: {
        type: "command",
        command:
          "printf '%s' '{\"decision\":\"block\",\"reason\":\"no Bash in tests\"}'",
      },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:json",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
    });
    assert(
      denied.permissionBehavior === "deny",
      "JSON decision=block → permissionBehavior=deny",
    );
    assert(
      denied.blockingError === "no Bash in tests",
      "JSON decision=block surfaces reason as blockingError",
    );
    assert(denied.outcome === "blocking", "outcome=blocking for JSON block");

    // (b) hookSpecificOutput.permissionDecision = "ask"
    const ask = await executeHookCommand({
      hook: {
        type: "command",
        command:
          "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"think first\"}}'",
      },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:json-ask",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
    });
    assert(
      ask.permissionBehavior === "ask",
      "JSON permissionDecision=ask honored",
    );
    assert(
      ask.permissionDecisionReason === "think first",
      "permissionDecisionReason surfaces",
    );

    // (c) additionalContext via hookSpecificOutput
    const ctx = await executeHookCommand({
      hook: {
        type: "command",
        command:
          "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"git status: clean\"}}'",
      },
      hookEvent: "UserPromptSubmit",
      hookName: "UserPromptSubmit:json",
      hookInput: {
        hook_event_name: "UserPromptSubmit",
        session_id: "",
        cwd,
        prompt: "hi",
      },
      cwd,
    });
    assert(
      ctx.additionalContext === "git status: clean",
      "JSON additionalContext extracted",
    );

    // (d) continue: false → preventContinuation
    const halt = await executeHookCommand({
      hook: {
        type: "command",
        command:
          "printf '%s' '{\"continue\":false,\"stopReason\":\"daily token budget exhausted\"}'",
      },
      hookEvent: "Stop",
      hookName: "Stop:halt",
      hookInput: {
        hook_event_name: "Stop",
        session_id: "",
        cwd,
      },
      cwd,
    });
    assert(
      halt.preventContinuation === true,
      "continue=false → preventContinuation",
    );
    assert(
      halt.stopReason === "daily token budget exhausted",
      "stopReason surfaces",
    );
  }

  // ─── [6] Executor — timeout + abort + missing binary ───────────
  console.log("\n[6] executor — timeout / abort / spawn failure");

  {
    const cwd = process.cwd();

    // (a) Timeout — sleep 5s with 1s timeout
    const start = Date.now();
    const slow = await executeHookCommand({
      hook: { type: "command", command: "sleep 5", timeout: 1 },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:slow",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
    });
    const elapsed = Date.now() - start;
    assert(
      slow.outcome === "non_blocking_error",
      "timed-out hook → non_blocking_error",
    );
    assert(
      slow.stderr.includes("timed out"),
      "timeout message present in stderr",
    );
    assert(elapsed < 3000, `timeout actually triggers around 1s (was ${elapsed}ms)`);

    // (b) Abort — fire signal AFTER spawn
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await executeHookCommand({
      hook: { type: "command", command: "sleep 10", timeout: 30 },
      hookEvent: "PreToolUse",
      hookName: "PreToolUse:aborted",
      hookInput: {
        hook_event_name: "PreToolUse",
        session_id: "",
        cwd,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "x",
      },
      cwd,
      signal: controller.signal,
    });
    assert(
      aborted.outcome === "cancelled",
      "abort signal → outcome=cancelled",
    );
  }

  // ─── [7] Aggregator — precedence rules ──────────────────────────
  console.log("\n[7] aggregator — deny > ask > allow, context concatenation");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "echo first" },
            {
              type: "command",
              command:
                "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\"}}'",
            },
            {
              type: "command",
              command:
                ">&2 echo 'absolutely not'; exit 2",
            },
            {
              type: "command",
              command:
                "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'",
            },
          ],
        },
      ],
    });

    const outcome = await runPreToolUseHooks({
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tu-1",
      cwd,
    });

    assert(
      outcome.results.length === 4,
      "4 hooks ran, 4 results returned",
    );
    assert(
      outcome.permissionBehavior === "deny",
      "deny wins over ask + allow (precedence)",
    );
    assert(
      outcome.blockingError === "absolutely not",
      "first blockingError is preserved",
    );
  });

  // ─── [8] runPreToolUseHooks round-trip ─────────────────────────
  console.log("\n[8a] runPreToolUseHooks — round-trip from settings.json");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command:
                "printf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"no shell please\"}}'",
            },
          ],
        },
      ],
    });

    const outcome = await runPreToolUseHooks({
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "tu-1",
      cwd,
    });
    assert(outcome.permissionBehavior === "deny", "deny round-trip");
    assert(
      outcome.permissionDecisionReason === "no shell please",
      "reason round-trip",
    );

    // Tool not matched → no hook fires
    const other = await runPreToolUseHooks({
      toolName: "Read",
      toolInput: {},
      toolUseId: "tu-2",
      cwd,
    });
    assert(
      other.results.length === 0,
      "non-matching tool → no hook fires",
    );
  });

  console.log("\n[8b] runPostToolUseHooks — additionalContext appended");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      PostToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "echo 'tool finished'" },
          ],
        },
      ],
    });

    const outcome = await runPostToolUseHooks({
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolResponse: { content: "ok", isError: false },
      toolUseId: "tu-1",
      cwd,
    });
    assert(
      outcome.additionalContext === "tool finished",
      "PostToolUse plain stdout becomes aggregated additionalContext",
    );
  });

  console.log("\n[8c] runUserPromptSubmitHooks");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "echo 'context-prefix'" },
          ],
        },
      ],
    });

    const outcome = await runUserPromptSubmitHooks({
      prompt: "implement feature X",
      cwd,
    });
    assert(
      outcome.additionalContext === "context-prefix",
      "UserPromptSubmit additionalContext extracted",
    );
  });

  console.log("\n[8d] runSessionStartHooks");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "echo 'boot-up'" }],
        },
        {
          matcher: "resume",
          hooks: [{ type: "command", command: "echo 'welcome-back'" }],
        },
      ],
    });

    const startup = await runSessionStartHooks({
      source: "startup",
      cwd,
    });
    assert(
      startup.additionalContext === "boot-up",
      "SessionStart matcher='startup' fires the startup hook",
    );

    const resume = await runSessionStartHooks({
      source: "resume",
      cwd,
    });
    assert(
      resume.additionalContext === "welcome-back",
      "SessionStart matcher='resume' fires the resume hook",
    );
  });

  console.log("\n[8e] runStopHooks");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      Stop: [
        {
          hooks: [
            { type: "command", command: "echo 'remember to commit'" },
          ],
        },
      ],
    });

    const outcome = await runStopHooks({
      lastAssistantMessage: "I'm done.",
      cwd,
    });
    assert(
      outcome.results.length === 1,
      "Stop hook fires with no matcher field",
    );
    assert(
      outcome.results[0]?.outcome === "success",
      "stop hook succeeded",
    );
  });

  console.log("\n[8f] runSubagentStopHooks");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      SubagentStop: [
        {
          matcher: "general-purpose",
          hooks: [
            { type: "command", command: "echo 'log subagent finish'" },
          ],
        },
      ],
    });

    const outcome = await runSubagentStopHooks({
      agentId: "sub-1",
      agentType: "general-purpose",
      cwd,
    });
    assert(
      outcome.results.length === 1,
      "SubagentStop matcher='general-purpose' fires",
    );

    const wrong = await runSubagentStopHooks({
      agentId: "sub-2",
      agentType: "Explore",
      cwd,
    });
    assert(
      wrong.results.length === 0,
      "non-matching agent_type → no hook fires",
    );
  });

  // ─── [9] Master kill-switch ────────────────────────────────────
  console.log("\n[9] kill-switch — EASY_AGENT_DISABLE_HOOKS");

  await withTempHome(async (home, cwd) => {
    await writeUserSettings(home, {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "echo should-not-run" }] },
      ],
    });

    const prevKill = process.env["EASY_AGENT_DISABLE_HOOKS"];
    try {
      process.env["EASY_AGENT_DISABLE_HOOKS"] = "1";
      assert(hooksGloballyDisabled() === true, "kill switch reads env");

      const outcome = await runUserPromptSubmitHooks({
        prompt: "hi",
        cwd,
      });
      assert(
        outcome.results.length === 0,
        "kill switch short-circuits ALL hooks regardless of settings.json",
      );
    } finally {
      if (prevKill !== undefined) process.env["EASY_AGENT_DISABLE_HOOKS"] = prevKill;
      else delete process.env["EASY_AGENT_DISABLE_HOOKS"];
    }
  });

  // ─── Summary ────────────────────────────────────────────────────
  console.log("");
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("✓ All stage 22 tests passed.");
    process.exit(0);
  }
}

// Avoid an unused-import warning if we ever stop referring to one of
// these types directly in the body.
void ({} as HookResult);

main().catch((err: unknown) => {
  console.error("Test script crashed:", err);
  process.exit(2);
});

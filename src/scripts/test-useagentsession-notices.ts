/**
 * Unit tests for the pure helpers extracted from useAgentSession (二期 C1):
 * markToolCallComplete / splitHeader / buildCommandNotice / CLEAR_TERMINAL.
 *
 * These are React-free, closure-free functions, so they're tested in isolation
 * without rendering the hook. Run: `npm run test:notices`.
 */

import assert from "node:assert";
import {
  markToolCallComplete,
  splitHeader,
  buildCommandNotice,
  CLEAR_TERMINAL,
  tokenWarningNotice,
  turnCompleteNotice,
  compactionNotice,
  apiRetryNotice,
  modeChangeNotice,
} from "../ui/hooks/useAgentSession/notices.js";
import { classifyUserInput } from "../ui/hooks/useAgentSession/inputClassification.js";
import type { TokenWarningResult } from "../context/autoCompact.js";
import type { ToolCallInfo } from "../ui/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

console.log("=== buildCommandNotice ===");

check('"Commands:" → "Available commands" panel with fixed body', () => {
  const notice = buildCommandNotice("Commands:\n(anything here is ignored)", "info");
  assert.equal(notice.tone, "info");
  assert.equal(notice.title, "Available commands");
  // Body is the canned help list, not the input text.
  assert.ok(notice.body.startsWith("/help — Show available commands"));
  assert.ok(notice.body.includes("/exit | /quit | /bye — Exit session"));
  assert.ok(!notice.body.includes("anything here is ignored"));
});

check('"Unknown command: /foo" → error tone, header/body split', () => {
  const notice = buildCommandNotice("Unknown command: /foo\nTry /help", "error");
  assert.equal(notice.tone, "error");
  assert.equal(notice.title, "Unknown command: /foo");
  assert.equal(notice.body, "Try /help");
});

check('"Unknown skill:" also routes to the error split', () => {
  const notice = buildCommandNotice("Unknown skill: foo", "error");
  assert.equal(notice.tone, "error");
  assert.equal(notice.title, "Unknown skill: foo");
  assert.equal(notice.body, "");
});

check("single-line error → labeled 'Error' with full body", () => {
  const notice = buildCommandNotice("boom went the engine", "error");
  assert.equal(notice.tone, "error");
  assert.equal(notice.title, "Error");
  assert.equal(notice.body, "boom went the engine");
});

check("multi-line error → first line title, rest body", () => {
  const notice = buildCommandNotice("Config error\ndetail line 1\ndetail line 2", "error");
  assert.equal(notice.tone, "error");
  assert.equal(notice.title, "Config error");
  assert.equal(notice.body, "detail line 1\ndetail line 2");
});

check("generic info → first line title, remaining lines body", () => {
  const notice = buildCommandNotice("Skills (3 loaded)\n- a\n- b\n- c", "info");
  assert.equal(notice.tone, "info");
  assert.equal(notice.title, "Skills (3 loaded)");
  assert.equal(notice.body, "- a\n- b\n- c");
});

console.log("=== splitHeader ===");

check("single line → title only, empty body", () => {
  const { title, body } = splitHeader("Model status");
  assert.equal(title, "Model status");
  assert.equal(body, "");
});

check("trims title and skips blank lines between header and body", () => {
  const { title, body } = splitHeader("  Header  \n\n\nfirst body line\nsecond");
  assert.equal(title, "Header");
  assert.equal(body, "first body line\nsecond");
});

check("blank body lines AFTER the first content line are preserved", () => {
  const { title, body } = splitHeader("Header\nbody\n\ntail");
  assert.equal(title, "Header");
  assert.equal(body, "body\n\ntail");
});

console.log("=== markToolCallComplete ===");

const baseCalls: ToolCallInfo[] = [
  { id: "a", name: "Read" },
  { id: "b", name: "Read" },
  { id: "c", name: "Bash" },
];

check("updates exactly the matching id, leaves others untouched", () => {
  const next = markToolCallComplete(baseCalls, "b", { resultLength: 42, isError: false });
  assert.equal(next.length, 3);
  assert.deepEqual(next[0], { id: "a", name: "Read" });
  assert.deepEqual(next[1], { id: "b", name: "Read", resultLength: 42, isError: false });
  assert.deepEqual(next[2], { id: "c", name: "Bash" });
});

check("parallel same-name calls are NOT collapsed onto one card", () => {
  // Two Reads (a, b): completing "a" must not touch "b".
  const next = markToolCallComplete(baseCalls, "a", { resultLength: 1 });
  assert.equal(next[0]!.resultLength, 1);
  assert.equal(next[1]!.resultLength, undefined);
});

check("unknown id → no-op (returns an equivalent array)", () => {
  const next = markToolCallComplete(baseCalls, "zzz", { resultLength: 9 });
  assert.deepEqual(next, baseCalls);
});

check("does not mutate the input array or its elements", () => {
  const input: ToolCallInfo[] = [{ id: "a", name: "Read" }];
  const next = markToolCallComplete(input, "a", { resultLength: 5 });
  assert.notEqual(next, input);
  assert.notEqual(next[0], input[0]);
  assert.equal(input[0]!.resultLength, undefined);
});

console.log("=== CLEAR_TERMINAL ===");

check("is the 2J + 3J + H escape sequence", () => {
  assert.equal(CLEAR_TERMINAL, "\u001B[2J\u001B[3J\u001B[H");
});

console.log("=== tokenWarningNotice ===");

const warn = (state: TokenWarningResult["state"]): TokenWarningResult => ({
  state,
  estimatedTokens: 80_000,
  threshold: 70_000,
  blockingLimit: 95_000,
  contextWindow: 100_000,
});

check('"warning" → info tone, "filling up", correct percent', () => {
  const n = tokenWarningNotice(warn("warning"))!;
  assert.equal(n.tone, "info");
  assert.equal(n.title, "Context window filling up");
  assert.ok(n.body.startsWith("80% used (80000 / 100000 tokens)"));
  assert.ok(n.body.includes("Consider using /compact."));
});

check('"error" → error tone, "nearly full"', () => {
  const n = tokenWarningNotice(warn("error"))!;
  assert.equal(n.tone, "error");
  assert.equal(n.title, "Context window nearly full");
  assert.ok(n.body.includes("Auto-compaction will trigger."));
});

check('"blocking" → error tone, "limit reached"', () => {
  const n = tokenWarningNotice(warn("blocking"))!;
  assert.equal(n.tone, "error");
  assert.equal(n.title, "Context window limit reached");
  assert.ok(n.body.includes("Use /compact to free space."));
});

check('"normal" → null (no notice)', () => {
  assert.equal(tokenWarningNotice(warn("normal")), null);
});

console.log("=== turnCompleteNotice ===");

check('"max_turns" → error notice with turn count', () => {
  const n = turnCompleteNotice("max_turns", 12)!;
  assert.equal(n.tone, "error");
  assert.equal(n.title, "Maximum tool turns reached");
  assert.equal(n.body, "Reached maximum tool turns (12).");
});

check('"blocking_limit" → error notice', () => {
  const n = turnCompleteNotice("blocking_limit", 3)!;
  assert.equal(n.tone, "error");
  assert.equal(n.title, "Context window limit reached");
});

check('"completed" / "aborted" / "model_error" → null', () => {
  assert.equal(turnCompleteNotice("completed", 1), null);
  assert.equal(turnCompleteNotice("aborted", 1), null);
  assert.equal(turnCompleteNotice("model_error", 1), null);
});

console.log("=== compactionNotice ===");

check('"micro" → micro title + tool-results body', () => {
  const n = compactionNotice("micro");
  assert.equal(n.tone, "info");
  assert.equal(n.title, "Context micro-compacted");
  assert.equal(n.body, "Old tool results cleared to save context space.");
});

check('"auto" → auto title + summary body', () => {
  const n = compactionNotice("auto");
  assert.equal(n.title, "Context auto-compacted");
  assert.ok(n.body.includes("summarized"));
});

check('"manual" → "Conversation compacted" title', () => {
  const n = compactionNotice("manual");
  assert.equal(n.title, "Conversation compacted");
});

console.log("=== apiRetryNotice ===");

check("formats delay in seconds + attempt/maxRetries", () => {
  const n = apiRetryNotice({ delayMs: 2500, message: "429 rate limited", attempt: 2, maxRetries: 5 });
  assert.equal(n.tone, "info");
  assert.equal(n.title, "Retrying request");
  assert.equal(n.body, "429 rate limited\nRetrying in 2.5s… (attempt 2/5).");
});

console.log("=== modeChangeNotice ===");

check('"plan" → "Entered plan mode" + read-only body', () => {
  const n = modeChangeNotice("plan");
  assert.equal(n.tone, "info");
  assert.equal(n.title, "Entered plan mode");
  assert.ok(n.body.startsWith("Only read-only tools"));
});

check('non-plan → "Exited plan mode" + interpolated mode', () => {
  const n = modeChangeNotice("default");
  assert.equal(n.title, "Exited plan mode");
  assert.equal(n.body, "Returned to default mode. Full tool access restored.");
});

console.log("=== classifyUserInput ===");

check("plain chat → LLM-triggering, not a slash command", () => {
  const c = classifyUserInput("hello there");
  assert.equal(c.isSlashCommand, false);
  assert.equal(c.rawCommandName, "");
  assert.equal(c.isLlmTriggering, true);
});

check("built-in system command (/help) → slash, NOT LLM-triggering", () => {
  const c = classifyUserInput("/help");
  assert.equal(c.isSlashCommand, true);
  assert.equal(c.rawCommandName, "help");
  assert.equal(c.isSkillCommand, false);
  assert.equal(c.isUserCommand, false);
  assert.equal(c.isPromptCommand, false);
  assert.equal(c.isLlmTriggering, false);
});

check("unknown slash command → not LLM-triggering (no registry match)", () => {
  const c = classifyUserInput("/totally-unknown-xyz arg");
  assert.equal(c.isSlashCommand, true);
  assert.equal(c.rawCommandName, "totally-unknown-xyz");
  assert.equal(c.isLlmTriggering, false);
});

check("rawCommandName is the first token only, args ignored", () => {
  const c = classifyUserInput("/model claude-opus-4");
  assert.equal(c.rawCommandName, "model");
});

console.log(`\n\u2705 ${passed} passed, 0 failed`);

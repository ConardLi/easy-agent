/**
 * Step 11 - Context compaction: token estimation, micro-compact, and full summarization
 *
 * Goal:
 * - estimate token usage with char-based heuristics + API usage anchor
 * - micro-compact old tool results (zero API cost)
 * - full compact via AI-generated summary when over threshold
 * - preserve tool_use / tool_result pairing across compaction
 * - support /compact with optional focus instructions
 *
 * This file distills the core compaction logic from src/context/compaction.ts
 * and src/utils/tokens.ts into a self-contained learning module.
 */

// ─── Token Estimation ──────────────────────────────────────────────

const TEXT_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 2;
const MESSAGE_OVERHEAD_TOKENS = 12;
const TOOL_BLOCK_OVERHEAD_TOKENS = 24;
const FIXED_BINARY_BLOCK_TOKENS = 2_000;

const MODEL_CONTEXT_WINDOW = 200_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

function roughTokenCount(content, charsPerToken = TEXT_CHARS_PER_TOKEN) {
  return Math.max(1, Math.round(content.length / charsPerToken));
}

function estimateContentBlockTokens(content) {
  if (typeof content === "string") return roughTokenCount(content);
  if (!Array.isArray(content)) return 0;

  return content.reduce((total, block) => {
    switch (block.type) {
      case "text":
        return total + roughTokenCount(block.text);
      case "tool_use":
        return total + TOOL_BLOCK_OVERHEAD_TOKENS +
          roughTokenCount(block.name) +
          roughTokenCount(JSON.stringify(block.input ?? {}), JSON_CHARS_PER_TOKEN);
      case "tool_result": {
        const s = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        return total + TOOL_BLOCK_OVERHEAD_TOKENS + roughTokenCount(s, JSON_CHARS_PER_TOKEN);
      }
      case "image":
      case "document":
        return total + FIXED_BINARY_BLOCK_TOKENS;
      default:
        return total + roughTokenCount(JSON.stringify(block), JSON_CHARS_PER_TOKEN);
    }
  }, 0);
}

export function estimateMessageTokens(message) {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentBlockTokens(message.content);
}

export function estimateMessagesTokens(messages) {
  const raw = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  return Math.ceil((raw * 4) / 3); // conservative 33% bump
}

/**
 * Hybrid estimation: use last API usage as anchor + estimate suffix.
 *
 * When we have a recent API response, its `usage.input_tokens` already
 * reflects the exact token count of the full prompt at that point.
 * We only need to estimate tokens for messages added after that point.
 */
export function tokenCountWithEstimation(messages, options = {}) {
  const { usage, usageAnchorIndex } = options;

  if (usage && usageAnchorIndex !== undefined && usageAnchorIndex >= 0) {
    const knownTokens =
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.output_tokens;
    const suffix = messages.slice(usageAnchorIndex + 1);
    return knownTokens + estimateMessagesTokens(suffix);
  }

  return estimateMessagesTokens(messages);
}

// ─── Token Budget Snapshot ─────────────────────────────────────────

export function buildTokenBudgetSnapshot(messages, options = {}) {
  const estimatedTokens = tokenCountWithEstimation(messages, options);
  const effectiveWindow = MODEL_CONTEXT_WINDOW - 20_000;
  return {
    estimatedTokens,
    contextWindow: MODEL_CONTEXT_WINDOW,
    effectiveWindow,
    autoCompactThreshold: effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS,
  };
}

// ─── MicroCompact ──────────────────────────────────────────────────

const MICROCOMPACT_MIN_MESSAGES = 10;
const MICROCOMPACT_KEEP_RECENT = 8;
const COMPACTABLE_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);
const CLEARED_PLACEHOLDER = "[Old tool result content cleared]";

function microCompactMessage(message) {
  if (!Array.isArray(message.content)) return { message, cleared: false };

  let cleared = false;
  const content = message.content.map((block) => {
    if (block.type !== "tool_result" || typeof block.content !== "string") return block;

    const toolName = block.content.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (!toolName || !COMPACTABLE_TOOLS.has(toolName)) return block;

    cleared = true;
    return { ...block, content: CLEARED_PLACEHOLDER };
  });

  return { message: { ...message, content }, cleared };
}

export function microCompactMessages(messages) {
  if (messages.length < MICROCOMPACT_MIN_MESSAGES) return { messages, didClear: false };

  let didClear = false;
  const result = messages.map((msg, i) => {
    if (i >= messages.length - MICROCOMPACT_KEEP_RECENT) return msg;
    const { message, cleared } = microCompactMessage(msg);
    if (cleared) didClear = true;
    return message;
  });

  return { messages: result, didClear };
}

// ─── Tail Preservation ─────────────────────────────────────────────

/**
 * Find a safe start index for the preserved tail.
 *
 * We must not split a tool_use / tool_result pair across the
 * summary boundary — the API requires them to appear together.
 */
function findSafeTailStart(messages, desiredCount) {
  let start = Math.max(0, messages.length - desiredCount);

  while (start > 0) {
    const tail = messages.slice(start);
    const useIds = new Set();
    const resultIds = new Set();

    for (const msg of tail) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === "tool_use") useIds.add(b.id);
        if (b.type === "tool_result") resultIds.add(b.tool_use_id);
      }
    }

    const hasDangling = [...resultIds].some((id) => !useIds.has(id));
    if (!hasDangling) return start;
    start--;
  }

  return 0;
}

// ─── Full Compaction ───────────────────────────────────────────────

const COMPACT_SYSTEM_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far.
Capture: user requests, technical decisions, file names, code snippets,
errors encountered, pending tasks, and what was being worked on most recently.

Wrap your analysis in <analysis> tags, then provide the final <summary>.`;

/**
 * Full compaction: summarize history + keep recent tail.
 *
 * @param {Function} callModel - async (system, messages) => string
 *   Abstracted so this module stays independent of any specific API client.
 */
export async function compactMessages(messages, callModel, options = {}) {
  // Step 1: micro-compact first (free)
  const { messages: microCompacted, didClear } = microCompactMessages(messages);

  // Step 2: check budget
  const budget = buildTokenBudgetSnapshot(microCompacted, options);
  if (!options.force && budget.estimatedTokens < budget.autoCompactThreshold) {
    return { messages: microCompacted, didCompact: false, didMicroCompact: didClear };
  }

  // Step 3: generate summary via model
  const summary = await callModel(COMPACT_SYSTEM_PROMPT, [
    { role: "user", content: `Conversation to summarize:\n${JSON.stringify(microCompacted, null, 2)}` },
  ]);

  // Step 4: build compacted message list
  const tailStart = microCompacted.length <= 8
    ? microCompacted.length
    : findSafeTailStart(microCompacted, 8);
  const tail = microCompacted.slice(tailStart);

  const compacted = [
    {
      role: "user",
      content: [
        "This session is being continued from a previous conversation that ran out of context.",
        `The summary below covers the earlier portion of the conversation.\n\n${summary}`,
        tail.length > 0 ? "\nRecent messages are preserved verbatim." : "",
      ].filter(Boolean).join(" "),
    },
    {
      role: "assistant",
      content: `[CompactBoundary] type=auto messages=${microCompacted.length}`,
    },
    ...tail,
  ];

  return { messages: compacted, summary, didCompact: true, didMicroCompact: didClear };
}

// ─── Demo ──────────────────────────────────────────────────────────

function main() {
  // Simulate a conversation with many tool calls
  const messages = [];
  for (let i = 0; i < 15; i++) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `Looking at file ${i}...` },
        { type: "tool_use", id: `tool_${i}`, name: "Read", input: { file_path: `src/file${i}.ts` } },
      ],
    });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `tool_${i}`, content: `Read:${"x".repeat(500)}` },
      ],
    });
  }

  console.log("=== Token Estimation ===");
  console.log(`Messages: ${messages.length}`);
  console.log(`Estimated tokens: ${estimateMessagesTokens(messages)}`);

  const budget = buildTokenBudgetSnapshot(messages);
  console.log(`Auto-compact threshold: ${budget.autoCompactThreshold}`);
  console.log(`Over threshold: ${budget.estimatedTokens >= budget.autoCompactThreshold}`);

  console.log("\n=== MicroCompact ===");
  const { messages: micro, didClear } = microCompactMessages(messages);
  console.log(`Did clear: ${didClear}`);

  const oldTokens = estimateMessagesTokens(messages);
  const newTokens = estimateMessagesTokens(micro);
  console.log(`Before: ${oldTokens} tokens → After: ${newTokens} tokens`);
  console.log(`Saved: ${oldTokens - newTokens} tokens (${Math.round((1 - newTokens / oldTokens) * 100)}%)`);

  // Check that tool_use/tool_result pairing is preserved
  let pairs = 0;
  for (const msg of micro) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === "tool_result") pairs++;
    }
  }
  console.log(`Tool result blocks preserved: ${pairs}`);
}

main();

/**
 * Auto Mode AI classifier.
 *
 * Reference: claude-code-source-code/src/utils/permissions/yoloClassifier.ts
 *
 * Given the conversation transcript and a single proposed tool action, the
 * classifier makes ONE lightweight, non-streaming API call and returns a
 * binary verdict: `shouldBlock` true (needs human confirmation) or false
 * (auto-approve). The tri-state allow/deny/ask seen by callers is derived in
 * the permission layer — this module only produces the block/allow signal
 * plus an `unavailable` flag for graceful degradation.
 *
 * NOTE (Stage 1): this module is standalone and is NOT yet wired into
 * `checkPermission`. It can be exercised directly (see step snapshot /
 * verification script) without affecting any existing permission path.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { createMessage } from "../services/api/streaming.js";
import { debugLog } from "../utils/log.js";
import {
  buildAutoClassifierSystemPrompt,
  type AutoClassifierPromptOptions,
} from "./autoClassifierPrompt.js";

/** Max characters of a single tool input we embed before truncating. */
const MAX_INPUT_CHARS = 2000;
/** Max characters of a transcript entry's text before truncating. */
const MAX_ENTRY_CHARS = 1500;
/** Output budget for the classifier call — it only emits a small verdict. */
const CLASSIFIER_MAX_TOKENS = 1024;

export interface AutoClassifierInput extends AutoClassifierPromptOptions {
  /** Full conversation so far (used to infer user intent). */
  messages: MessageParam[];
  /** The tool the agent wants to call. */
  toolName: string;
  /** The proposed tool input. */
  toolInput: Record<string, unknown>;
  /** Override classifier model; defaults to env / main model. */
  model?: string;
}

export interface AutoClassifierResult {
  /** true → require human confirmation; false → auto-approve. */
  shouldBlock: boolean;
  /** Short justification for the verdict (shown to the user / agent). */
  reason: string;
  /** The classifier's private reasoning, when provided. */
  thinking?: string;
  /**
   * Set when the classifier could not produce a usable verdict (API error,
   * no structured tool_use in the response, malformed fields). Callers MUST
   * treat this as "do not auto-allow" and fall back to manual confirmation.
   */
  unavailable?: boolean;
  /** Model actually used for the classification. */
  model: string;
}

/** Structured tool the classifier is forced to call. */
const CLASSIFY_RESULT_TOOL: Anthropic.Tool = {
  name: "classify_result",
  description:
    "Report your security classification of the agent's proposed action.",
  input_schema: {
    type: "object",
    properties: {
      thinking: {
        type: "string",
        description:
          "Your step-by-step reasoning: the action's practical effect, whether the user requested it, and which decision category it matches.",
      },
      shouldBlock: {
        type: "boolean",
        description:
          "true if the action requires explicit human confirmation; false if it is safe to auto-approve.",
      },
      reason: {
        type: "string",
        description:
          "A one-sentence explanation of the verdict, suitable for showing the user.",
      },
    },
    required: ["thinking", "shouldBlock", "reason"],
  },
};

function resolveClassifierModel(override?: string): string {
  return (
    override ??
    process.env.EASY_AGENT_AUTO_MODE_MODEL ??
    process.env.ANTHROPIC_MODEL ??
    "claude-3-5-haiku-latest"
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

function extractText(content: ContentBlockParam[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlockParam, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Build a compact transcript focused on what matters for intent inference:
 * the user's own messages and the tool calls the agent has already made.
 * Free-form assistant prose is intentionally omitted — per the prompt's
 * anti-injection heuristic, the agent's narration must not sway the verdict.
 */
function buildTranscript(messages: MessageParam[]): string {
  const entries: string[] = [];

  for (const message of messages) {
    const content = message.content;

    if (typeof content === "string") {
      if (message.role === "user" && content.trim()) {
        entries.push(`USER: ${truncate(content.trim(), MAX_ENTRY_CHARS)}`);
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    if (message.role === "user") {
      const text = extractText(content);
      if (text) {
        entries.push(`USER: ${truncate(text, MAX_ENTRY_CHARS)}`);
      }
      // Tool results are the environment's output, not user intent — note
      // them tersely so the action sequence stays legible.
      const toolResults = content.filter(
        (block): block is Extract<ContentBlockParam, { type: "tool_result" }> =>
          block.type === "tool_result",
      );
      if (toolResults.length > 0) {
        entries.push(`(tool results: ${toolResults.length})`);
      }
      continue;
    }

    // assistant: keep only the tool calls (the actions), drop the narration.
    const toolUses = content.filter(
      (block): block is Extract<ContentBlockParam, { type: "tool_use" }> =>
        block.type === "tool_use",
    );
    for (const block of toolUses) {
      entries.push(
        `AGENT CALLED ${block.name}: ${truncate(
          JSON.stringify(block.input ?? {}),
          MAX_ENTRY_CHARS,
        )}`,
      );
    }
  }

  if (entries.length === 0) return "(empty transcript)";
  return entries.join("\n");
}

export function formatActionForClassifier(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  const inputJson = truncate(JSON.stringify(toolInput ?? {}), MAX_INPUT_CHARS);
  return `The agent now wants to call the tool \`${toolName}\` with this input:\n${inputJson}`;
}

/**
 * Classify a single proposed action. Never throws — on any failure it returns
 * `{ unavailable: true, shouldBlock: true }` so callers degrade safely.
 */
export async function classifyAutoModeAction(
  input: AutoClassifierInput,
): Promise<AutoClassifierResult> {
  const model = resolveClassifierModel(input.model);
  const systemPrompt = buildAutoClassifierSystemPrompt({
    allowRules: input.allowRules,
    denyRules: input.denyRules,
  });

  const transcript = buildTranscript(input.messages);
  const action = formatActionForClassifier(input.toolName, input.toolInput);
  const userContent = `## Transcript\n${transcript}\n\n## Action to classify\n${action}`;

  debugLog("autoClassifier", "request", {
    model,
    toolName: input.toolName,
    transcriptChars: transcript.length,
  });

  try {
    const response = await createMessage({
      model,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
      tools: [CLASSIFY_RESULT_TOOL],
      toolChoice: { type: "tool", name: "classify_result" },
      querySource: "background",
    });

    const toolUse = response.content.find(
      (block) => block.type === "tool_use" && block.name === "classify_result",
    );

    if (!toolUse || toolUse.type !== "tool_use") {
      debugLog("autoClassifier", "no_tool_use", { stopReason: response.stopReason });
      return {
        shouldBlock: true,
        unavailable: true,
        reason: "Classifier returned no structured verdict.",
        model,
      };
    }

    const raw = toolUse.input as Record<string, unknown>;
    if (typeof raw.shouldBlock !== "boolean") {
      debugLog("autoClassifier", "malformed_verdict", { raw });
      return {
        shouldBlock: true,
        unavailable: true,
        reason: "Classifier verdict was malformed.",
        model,
      };
    }

    const result: AutoClassifierResult = {
      shouldBlock: raw.shouldBlock,
      reason:
        typeof raw.reason === "string" && raw.reason.trim()
          ? raw.reason.trim()
          : raw.shouldBlock
            ? "Action requires confirmation."
            : "Action classified as safe.",
      thinking: typeof raw.thinking === "string" ? raw.thinking : undefined,
      model,
    };

    debugLog("autoClassifier", "verdict", {
      shouldBlock: result.shouldBlock,
      reason: result.reason,
    });

    return result;
  } catch (error) {
    debugLog("autoClassifier", "error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      shouldBlock: true,
      unavailable: true,
      reason: "Classifier API call failed.",
      model,
    };
  }
}

/**
 * AskUserQuestion — let the model put a structured multiple-choice question
 * to the user instead of guessing or rattling off options in prose.
 *
 * The tool itself does no I/O of its own — it hands the questions to the frontend via
 * `context.requestUserQuestion`, which renders an interactive selector and
 * resolves with the user's choices. The tool then formats those answers back
 * to the model. If there's no interactive frontend (headless / pipe mode) the
 * callback is absent and we return a clear error so the model falls back to
 * asking inline.
 *
 * Schema: questions[].{question,header,options,multiSelect}; result text
 * starts with "User has answered your questions: …".
 */
import type { Tool, ToolContext, ToolResult, UserQuestion } from "./Tool.js";

const HEADER_MAX = 12;

interface RawOption {
  label?: unknown;
  description?: unknown;
}
interface RawQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function parseQuestions(input: Record<string, unknown>): UserQuestion[] | { error: string } {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { error: "questions must be a non-empty array (1-4 questions)" };
  }
  if (rawQuestions.length > 4) {
    return { error: "at most 4 questions are allowed" };
  }
  const questions: UserQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const raw of rawQuestions as RawQuestion[]) {
    if (typeof raw.question !== "string" || !raw.question.trim()) {
      return { error: "each question needs a non-empty `question` string" };
    }
    if (typeof raw.header !== "string" || !raw.header.trim()) {
      return { error: `question "${raw.question}" needs a short \`header\` label` };
    }
    if (seenQuestions.has(raw.question)) {
      return { error: "question texts must be unique" };
    }
    seenQuestions.add(raw.question);
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 4) {
      return { error: `question "${raw.question}" must have 2-4 options` };
    }
    const options: UserQuestion["options"] = [];
    const seenLabels = new Set<string>();
    for (const opt of raw.options as RawOption[]) {
      if (typeof opt.label !== "string" || !opt.label.trim()) {
        return { error: `each option in "${raw.question}" needs a non-empty \`label\`` };
      }
      if (seenLabels.has(opt.label)) {
        return { error: `option labels must be unique within "${raw.question}"` };
      }
      seenLabels.add(opt.label);
      options.push({
        label: opt.label,
        ...(typeof opt.description === "string" && opt.description.trim() ? { description: opt.description } : {}),
      });
    }
    questions.push({
      question: raw.question,
      header: raw.header.slice(0, HEADER_MAX),
      options,
      multiSelect: raw.multiSelect === true,
    });
  }
  return questions;
}

export const askUserQuestionTool: Tool = {
  name: "AskUserQuestion",
  searchHint: "prompt the user with a multiple-choice question",
  shouldDefer: true,
  description:
    "Ask the user one or more multiple-choice questions and wait for their " +
    "answer. Use this when you need the user to make a decision among " +
    "concrete alternatives (e.g. which library, which approach, which files " +
    "to touch) rather than guessing or asking in free-form prose. Provide " +
    "1-4 questions, each with a short `header` chip, the full `question` " +
    "text, and 2-4 distinct `options` (each with a `label` and a short " +
    "`description` of its trade-offs). Set `multiSelect: true` when the user " +
    "may pick more than one option. Do NOT add an 'Other' option — the UI " +
    "provides a way to decline.",
  inputSchema: {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        description: "1-4 multiple-choice questions to ask the user.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The complete question text. Should end with a question mark.",
            },
            header: {
              type: "string",
              description: `Very short chip label (max ${HEADER_MAX} chars), e.g. "Library", "Approach".`,
            },
            options: {
              type: "array",
              description: "2-4 distinct choices.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Concise display text (1-5 words)." },
                  description: {
                    type: "string",
                    description: "What choosing this option means or implies.",
                  },
                },
                required: ["label"],
              },
            },
            multiSelect: {
              type: "boolean",
              description: "Allow selecting multiple options. Default false.",
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },

  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const parsed = parseQuestions(input);
    if (!Array.isArray(parsed)) {
      return { content: `Error: ${parsed.error}`, isError: true };
    }

    if (!context.requestUserQuestion) {
      return {
        content:
          "Error: no interactive frontend is attached, so the user cannot be " +
          "prompted. Ask your question directly in your reply instead.",
        isError: true,
      };
    }

    const response = await context.requestUserQuestion({ questions: parsed });
    if (!response) {
      return {
        content: "The user declined to answer the question(s).",
        isError: false,
      };
    }

    const answersText = Object.entries(response.answers)
      .map(([question, answer]) => `"${question}" = "${answer}"`)
      .join(", ");
    return {
      content: `User has answered your questions: ${answersText}. Continue with the user's answers in mind.`,
      isError: false,
    };
  },

  isReadOnly(): boolean {
    return true;
  },

  isEnabled(): boolean {
    return true;
  },

  isConcurrencySafe(): boolean {
    // Interactive: must run serially so two questions never race for the
    // same keyboard / dialog slot.
    return false;
  },
};

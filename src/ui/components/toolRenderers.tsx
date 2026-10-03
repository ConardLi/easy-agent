/**
 * Tool-owned UI renderers (P1 #6).
 *
 * Instead of one growing `if (name === "Bash") … else if (name === "Edit") …`
 * chain inside the card component, each high-traffic tool registers its own
 * renderer here. A renderer can supply any of:
 *
 *   - renderToolUse        → the header descriptor (dot + label + target)
 *   - renderResultSummary  → the condensed `⎿` body (default history view)
 *   - renderResultVerbose  → the expanded body (Ctrl+O / fullscreen expand)
 *   - renderCard           → replaces the WHOLE card (header + body), for tools
 *                            whose layout doesn't fit the standard chrome (Agent)
 *   - handlesError         → opt out of the generic error body (Bash shows its
 *                            own stderr layer)
 *
 * The registry is the extension point for adding per-tool renderers and is
 * consumed by `renderInlineToolCard` (history) below.
 */
import type React from "react";
import { Box, Text } from "ink";
import {
  formatErrorBody,
  parseBashResult,
  summarizeTool,
  toolUseTag,
  type ToolLine,
  type ToolResultInfo,
} from "../utils/toolCardFormat.js";
import { isSilentBashCommand } from "../utils/toolClassify.js";
import { ResultLine, ToolCardHeader, ToolResultSummary } from "./ToolCard.js";
import { StructuredDiff } from "./StructuredDiff.js";
import { theme } from "../theme.js";

// Safety cap on how many output lines a verbose Bash card prints, so a runaway
// command (npm install, a 50k-line log) can't blow up the frame.
const BASH_VERBOSE_MAX_LINES = 200;
// Default (condensed) cap so the inline history stays an activity stream; the full output lives in the
// Ctrl+O transcript.
const BASH_DEFAULT_MAX_LINES = 3;

type Input = Record<string, unknown> | undefined;

export interface ToolRenderContext {
  input: Input;
  result: ToolResultInfo;
  /** True when rendering the expanded (Ctrl+O / fullscreen) view. */
  verbose: boolean;
}

export interface ToolRenderer {
  /** Header descriptor: dot + bold label + (target). */
  renderToolUse?(input: Input, result?: string): ToolLine;
  /** Replace the entire card (header + body). */
  renderCard?(ctx: ToolRenderContext): React.ReactNode;
  /** Condensed body shown under the header by default. */
  renderResultSummary?(ctx: ToolRenderContext): React.ReactNode;
  /** Expanded body shown in verbose mode (falls back to the summary). */
  renderResultVerbose?(ctx: ToolRenderContext): React.ReactNode;
  /** When true, the renderer's body covers error results too (skip the generic error card). */
  handlesError?: boolean;
}

// ── Shared body helpers ────────────────────────────────────────────────────

/** First non-empty line of a block of text (the condensed one-liner). */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return line;
  }
  return text.split("\n")[0] ?? "";
}

/**
 * Column of output lines (no gutter) — meant to sit inside a <ResultLine>,
 * which supplies the dimmed `⎿` corner. Caps at `max` with a "+N more" footer.
 */
function OutputBody({
  text,
  color,
  max = Infinity,
}: {
  text: string;
  color?: string;
  max?: number;
}): React.ReactNode {
  const lines = text.split("\n");
  const shown = Number.isFinite(max) ? lines.slice(0, max) : lines;
  const hidden = lines.length - shown.length;
  return (
    <>
      {shown.map((line, i) => (
        <Text key={i} color={color ?? theme.muted}>{line || " "}</Text>
      ))}
      {hidden > 0 ? (
        <Text color={theme.muted}>{`… +${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
      ) : null}
    </>
  );
}

/**
 * One output layer (stdout or stderr) capped at `max` lines, with a
 * `… +N lines (ctrl+o to expand)` footer when truncated. Designed to sit
 * inside a single `<ResultLine>` so stdout and stderr stack under one corner.
 */
function CappedLines({
  text,
  color,
  max,
}: {
  text: string;
  color: string;
  max: number;
}): React.ReactNode {
  const lines = text.split("\n");
  const shown = lines.slice(0, max);
  const hidden = lines.length - shown.length;
  return (
    <>
      {shown.map((line, i) => (
        <Text key={i} color={color} wrap="truncate-end">{line || " "}</Text>
      ))}
      {hidden > 0 ? (
        <Text key="more" color={theme.muted}>
          {`… +${hidden} line${hidden === 1 ? "" : "s"} (ctrl+o to expand)`}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Layered Bash result body:
 *   - stdout  → dim (muted)
 *   - stderr  → error (red), with <sandbox_violations> stripped
 *   - timeout → warning
 *   - empty   → "Done" (silent commands) or "(No output)"
 */
function BashResultBody({ result, verbose }: ToolRenderContext): React.ReactNode {
  const parsed = parseBashResult(result.content);
  const max = verbose ? BASH_VERBOSE_MAX_LINES : BASH_DEFAULT_MAX_LINES;
  const hasStdout = parsed.stdout.length > 0;
  const hasStderr = parsed.stderr.length > 0;

  if (parsed.timeoutMessage) {
    return (
      <ResultLine>
        <Text color={theme.warn}>{parsed.timeoutMessage}</Text>
      </ResultLine>
    );
  }

  if (!hasStdout && !hasStderr) {
    if (parsed.errorMessage) {
      return (
        <ResultLine>
          <CappedLines text={parsed.errorMessage} color={theme.error} max={max} />
        </ResultLine>
      );
    }
    if (parsed.hadSandboxViolation) {
      return (
        <ResultLine>
          <Text color={theme.warn}>{"Blocked by sandbox"}</Text>
        </ResultLine>
      );
    }
    const silent = parsed.command ? isSilentBashCommand(parsed.command) : false;
    return (
      <ResultLine>
        <Text color={theme.muted}>{silent ? "Done" : "(No output)"}</Text>
      </ResultLine>
    );
  }

  return (
    <ResultLine>
      {hasStdout ? <CappedLines text={parsed.stdout} color={theme.muted} max={max} /> : null}
      {hasStderr ? <CappedLines text={parsed.stderr} color={theme.error} max={max} /> : null}
    </ResultLine>
  );
}

/**
 * Pull the human-friendly Agent invocation summary out of a tool_use's raw
 * input. Agent calls always have `prompt` + `description` (required by the
 * schema) and an optional `subagent_type`; we surface only the short
 * description, not the noisy full prompt.
 */
function summarizeAgentInput(input: Input): { agentType: string; description?: string } | null {
  if (!input || typeof input !== "object") return null;
  const subagent = typeof input["subagent_type"] === "string" ? input["subagent_type"] : "general-purpose";
  const description = typeof input["description"] === "string" ? input["description"] : undefined;
  return { agentType: subagent || "general-purpose", description };
}

function InlineAgentCard({ input, result }: ToolRenderContext): React.ReactNode {
  const summary = summarizeAgentInput(input);
  const agentType = summary?.agentType ?? "general-purpose";
  const description = summary?.description;
  const color = result.isError ? "red" : "green";
  const mark = result.isError ? "✗" : "✓";

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color={color}>{`  ${mark} Agent`}</Text>
        <Text bold color={color}>{`[${agentType}]`}</Text>
        {description ? <Text>{`  ${description}`}</Text> : null}
        {result.isError ? <Text color="red">{" — failed"}</Text> : null}
      </Box>
      {result.isError && result.content ? (
        <Box marginLeft={4} flexDirection="column">
          <Text color="red">{formatErrorBody(result.content)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ── Edit / Write diff bodies ────────────────────────────────────────────────

function editDiff(input: Input): { oldText: string; newText: string } | null {
  const oldStr = typeof input?.old_string === "string" ? (input.old_string as string) : undefined;
  const newStr = typeof input?.new_string === "string" ? (input.new_string as string) : undefined;
  if (oldStr === undefined || newStr === undefined) return null;
  return { oldText: oldStr, newText: newStr };
}

function writeContentOf(input: Input): string | null {
  return typeof input?.content === "string" ? (input.content as string) : null;
}

function diffSummaryBody(line: ToolLine, hasDiff: boolean): React.ReactNode {
  return <ToolResultSummary line={line} expandable={hasDiff} />;
}

// ── The registry ────────────────────────────────────────────────────────────

const bashRenderer: ToolRenderer = {
  renderToolUse: (input, result) => summarizeTool("Bash", input, result),
  renderResultSummary: (ctx) => <BashResultBody {...ctx} />,
  renderResultVerbose: (ctx) => <BashResultBody {...ctx} />,
  handlesError: true,
};

const editRenderer: ToolRenderer = {
  renderToolUse: (input, result) => summarizeTool("Edit", input, result),
  renderResultSummary: (ctx) => {
    const line = summarizeTool("Edit", ctx.input, ctx.result.content);
    return diffSummaryBody(line, editDiff(ctx.input) !== null);
  },
  renderResultVerbose: (ctx) => {
    const line = summarizeTool("Edit", ctx.input, ctx.result.content);
    const diff = editDiff(ctx.input);
    if (!diff) return diffSummaryBody(line, false);
    return (
      <>
        <ToolResultSummary line={line} />
        <StructuredDiff oldText={diff.oldText} newText={diff.newText} />
      </>
    );
  },
};

const writeRenderer: ToolRenderer = {
  renderToolUse: (input, result) => summarizeTool("Write", input, result),
  renderResultSummary: (ctx) => {
    const line = summarizeTool("Write", ctx.input, ctx.result.content);
    return diffSummaryBody(line, writeContentOf(ctx.input) !== null);
  },
  renderResultVerbose: (ctx) => {
    const line = summarizeTool("Write", ctx.input, ctx.result.content);
    const content = writeContentOf(ctx.input);
    if (content === null) return diffSummaryBody(line, false);
    return (
      <>
        <ToolResultSummary line={line} />
        <StructuredDiff oldText="" newText={content} />
      </>
    );
  },
};

/** Read/Grep/Glob own only their header — the body is always the summary line. */
function summaryOnlyRenderer(name: string): ToolRenderer {
  return { renderToolUse: (input, result) => summarizeTool(name, input, result) };
}

export const toolRenderers: Record<string, ToolRenderer> = {
  Agent: { renderCard: (ctx) => <InlineAgentCard {...ctx} /> },
  Bash: bashRenderer,
  PowerShell: bashRenderer,
  Edit: editRenderer,
  Write: writeRenderer,
  Read: summaryOnlyRenderer("Read"),
  Grep: summaryOnlyRenderer("Grep"),
  Glob: summaryOnlyRenderer("Glob"),
};

// ── Dispatch (the new InlineToolCard body) ───────────────────────────────────

/** Generic error card for tools that don't render their own error body. */
function DefaultErrorCard({
  line,
  result,
  verbose,
  tag,
}: {
  line: ToolLine;
  result: ToolResultInfo;
  verbose: boolean;
  tag?: string;
}): React.ReactNode {
  const body = formatErrorBody(result.content);
  const multiLine = body.includes("\n");
  return (
    <Box flexDirection="column">
      <ToolCardHeader line={line} state="error" tag={tag} />
      {result.content ? (
        verbose ? (
          <ResultLine>
            <OutputBody text={body} color={theme.error} />
          </ResultLine>
        ) : (
          <ResultLine>
            <Text>
              <Text color={theme.error}>{firstLine(body)}</Text>
              {multiLine ? <Text color={theme.muted}>{"  (ctrl+o to expand)"}</Text> : null}
            </Text>
          </ResultLine>
        )
      ) : (
        <ToolResultSummary line={line} />
      )}
    </Box>
  );
}

/**
 * Render a committed tool call as an inline history card, dispatching through
 * the per-tool renderer registry. Visual styling mirrors `ToolCallList` so a
 * card in-flight and the same card archived in history look identical.
 */
export function renderInlineToolCard({
  name,
  input,
  result,
  verbose,
}: {
  name: string;
  input: Input;
  result: ToolResultInfo;
  /** Global Ctrl+O verbose flag: false = condensed `⎿` summary only. */
  verbose: boolean;
}): React.ReactNode {
  const renderer = toolRenderers[name];
  const ctx: ToolRenderContext = { input, result, verbose };

  // Whole-card override (Agent).
  if (renderer?.renderCard) return renderer.renderCard(ctx);

  const line = renderer?.renderToolUse?.(input, result.content) ?? summarizeTool(name, input, result.content);
  const tag = toolUseTag(name, input, result.content);

  // Errors: unless the tool renders its own error body (Bash), use the
  // generic error card.
  if (result.isError && !renderer?.handlesError) {
    return <DefaultErrorCard line={line} result={result} verbose={verbose} tag={tag} />;
  }

  // Tools with a custom body own their result rendering.
  if (renderer?.renderResultSummary || renderer?.renderResultVerbose) {
    const body = verbose
      ? (renderer.renderResultVerbose ?? renderer.renderResultSummary)!(ctx)
      : (renderer.renderResultSummary ?? renderer.renderResultVerbose)!(ctx);
    return (
      <Box flexDirection="column">
        <ToolCardHeader line={line} state={result.isError ? "error" : "ok"} tag={tag} />
        {body}
      </Box>
    );
  }

  // Default: header + condensed summary line (Read/Grep/Glob and any tool
  // without a registered body).
  return (
    <Box flexDirection="column">
      <ToolCardHeader line={line} state="ok" tag={tag} />
      <ToolResultSummary line={line} />
    </Box>
  );
}

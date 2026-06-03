/**
 * The interactive permission prompt shown before a guarded tool runs
 * (stage 7 + 24.4 polish). For file-touching tools it now previews the actual
 * change — a colored diff for Edit and the new-file content for Write — the
 * same "show me what you're about to do" UX as Claude Code's
 * FilesystemPermissionRequest, instead of a bare `args: {...}` dump.
 */
import React from "react";
import { Box, Text, useStdout } from "ink";
import { theme, glyph } from "../theme.js";
import { StructuredDiff } from "./StructuredDiff.js";
import { displayPath } from "../utils/toolCardFormat.js";
import type { PermissionPromptState } from "../types.js";

// Bound the preview so a huge edit/new file can't push the prompt's action
// line off-screen. Reviewers can read the full change in the Ctrl+O transcript.
const PREVIEW_MAX_LINES = 24;
const BASH_PREVIEW_MAX_LINES = 8;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function PermissionTitle({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.ReactNode {
  return (
    <Box paddingX={1}>
      <Text bold color={theme.info}>{title}</Text>
      {subtitle ? <Text color={theme.muted}>{`  ${displayPath(subtitle)}`}</Text> : null}
    </Box>
  );
}

function PreviewFrame({ children }: { children: React.ReactNode }): React.ReactNode {
  const { stdout } = useStdout();
  const width = Math.max(16, (stdout?.columns ?? 80) - 4);
  const rule = "\u2504".repeat(width);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.borderDim}>{rule}</Text>
      {children}
      <Text color={theme.borderDim}>{rule}</Text>
    </Box>
  );
}

function FileContentPreview({
  content,
  maxLines = PREVIEW_MAX_LINES,
}: {
  content: string;
  maxLines?: number;
}): React.ReactNode {
  const lines = content ? content.split("\n") : ["(No content)"];
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;
  const gutterWidth = String(lines.length).length;

  return (
    <PreviewFrame>
      <Box flexDirection="column" paddingX={1}>
        {shown.map((line, i) => (
          <Text key={i}>
            <Text color={theme.muted}>{String(i + 1).padStart(gutterWidth, " ")}</Text>
            <Text color={theme.muted}>{"  "}</Text>
            <Text>{line || " "}</Text>
          </Text>
        ))}
        {hidden > 0 ? (
          <Text color={theme.muted}>{`... +${hidden} more line${hidden === 1 ? "" : "s"}`}</Text>
        ) : null}
      </Box>
    </PreviewFrame>
  );
}

function DiffPreview({
  oldText,
  newText,
  maxLines,
}: {
  oldText: string;
  newText: string;
  maxLines?: number;
}): React.ReactNode {
  return (
    <PreviewFrame>
      <StructuredDiff oldText={oldText} newText={newText} maxLines={maxLines} />
    </PreviewFrame>
  );
}

/** The per-tool body of the prompt: a diff / content / command preview. */
function PermissionPreview({
  toolName,
  input,
  summary,
}: {
  toolName: string;
  input: Record<string, unknown> | undefined;
  summary: string;
}): React.ReactNode {
  const inp = input ?? {};

  if (toolName === "Edit") {
    const path = asString(inp.file_path) ?? "";
    const oldStr = asString(inp.old_string);
    const newStr = asString(inp.new_string);
    return (
      <Box flexDirection="column">
        <PermissionTitle title="Edit file" subtitle={path} />
        {oldStr !== undefined && newStr !== undefined ? (
          <DiffPreview oldText={oldStr} newText={newStr} maxLines={PREVIEW_MAX_LINES} />
        ) : null}
      </Box>
    );
  }

  if (toolName === "Write") {
    const path = asString(inp.file_path) ?? "";
    const content = asString(inp.content) ?? "";
    return (
      <Box flexDirection="column">
        <PermissionTitle title="Create file" subtitle={path} />
        <FileContentPreview content={content} />
      </Box>
    );
  }

  if (toolName === "MultiEdit") {
    const path = asString(inp.file_path) ?? "";
    const edits = Array.isArray(inp.edits) ? inp.edits : [];
    // Split the line budget across the edits so a many-edit batch still fits.
    const perEdit = Math.max(4, Math.floor(PREVIEW_MAX_LINES / Math.max(1, edits.length)));
    return (
      <Box flexDirection="column">
        <PermissionTitle title="Edit file" subtitle={path} />
        {edits.map((edit, i) => {
          const e = (edit ?? {}) as Record<string, unknown>;
          const oldStr = asString(e.old_string);
          const newStr = asString(e.new_string);
          if (oldStr === undefined || newStr === undefined) return null;
          return (
            <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text color={theme.muted}>{`  edit ${i + 1}/${edits.length}${e.replace_all === true ? " (all)" : ""}`}</Text>
              <DiffPreview oldText={oldStr} newText={newStr} maxLines={perEdit} />
            </Box>
          );
        })}
      </Box>
    );
  }

  if (toolName === "Bash") {
    const command = asString(inp.command) ?? "";
    const lines = command.split("\n").slice(0, BASH_PREVIEW_MAX_LINES);
    return (
      <Box flexDirection="column">
        <PermissionTitle title="Run command" />
        <Box marginLeft={2} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} color={theme.mdInlineCode}>{`$ ${line}`}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  // Anything else: fall back to the one-line argument summary.
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.info}>{toolName}</Text>
      <Text color={theme.muted}>{summary}</Text>
    </Box>
  );
}

/** Phrase the action question to match the operation. */
function actionQuestion(toolName: string): string {
  switch (toolName) {
    case "Edit":
      return "Do you want to make this edit?";
    case "MultiEdit":
      return "Do you want to make these edits?";
    case "Write":
      return "Do you want to create this file?";
    case "Bash":
      return "Do you want to run this command?";
    default:
      return "Do you want to proceed?";
  }
}

function PermissionOptions({
  toolName,
  selectedIndex,
}: {
  toolName: string;
  selectedIndex: number;
}): React.ReactNode {
  const sessionLabel = toolName === "WebFetch"
    ? "Yes, allow this domain during this session"
    : "Yes, allow this tool during this session";
  const options = [
    { label: "Yes", shortcut: "y" },
    { label: sessionLabel, shortcut: "a" },
    { label: "No", shortcut: "n" },
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={option.shortcut}>
            <Text color={selected ? theme.info : theme.muted}>
              {selected ? `${glyph.promptCaret} ` : "  "}
              {`${index + 1}. `}
            </Text>
            <Text>{option.label}</Text>
            <Text color={theme.muted}>{`  (${option.shortcut})`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function PermissionRequestCard({
  prompt,
  selectedOptionIndex = 0,
}: {
  prompt: PermissionPromptState;
  selectedOptionIndex?: number;
}): React.ReactNode {
  return (
    <>
      <Box
        marginTop={1}
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.info}
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
      >
        <PermissionPreview toolName={prompt.toolName} input={prompt.input} summary={prompt.summary} />

        <Box marginTop={1} flexDirection="column" paddingX={1}>
          <Text>{actionQuestion(prompt.toolName)}</Text>
          <PermissionOptions toolName={prompt.toolName} selectedIndex={selectedOptionIndex} />
        </Box>
      </Box>
      <Box paddingX={1} marginTop={1}>
        <Text color={theme.muted}>Esc to cancel</Text>
      </Box>
    </>
  );
}

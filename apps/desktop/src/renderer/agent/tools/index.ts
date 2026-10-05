import type { SubAgentProgress } from "../../../shared/agent";
import type { DiffLine, ToolCall, ToolName, ToolStatus } from "../viewModel";

/** What is known about one tool call, from the committed messages and the live events. */
export interface ToolFacts {
  id: string;
  name: string;
  /** Missing while the call is still streaming. */
  input?: Record<string, unknown>;
  result?: { text: string; isError: boolean };
  /** No result yet and the turn is still running. */
  running: boolean;
  startedAt?: number;
  completedAt?: number;
  /** Live output of a running shell command. */
  liveOutput?: string;
  /** Progress of a sub-agent the call started. */
  subagent?: SubAgentProgress;
  cwd?: string;
}

/** Longest output kept for a card; the model already has the full text. */
const OUTPUT_LIMIT = 20_000;
const DIFF_LIMIT = 400;

const str = (value: unknown) => (typeof value === "string" ? value : "");

function relative(path: string, cwd?: string): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

const clip = (text: string) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…` : text);

function lines(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

/** Diff of one replacement: shared leading and trailing lines become context. */
export function replacementDiff(before: string, after: string, firstLine = 1): { lines: DiffLine[]; added: number; removed: number } {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  let oldNo = firstLine;
  let newNo = firstLine;
  for (const text of a.slice(0, head)) out.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  for (const text of removed) out.push({ type: "del", text, oldNo: oldNo++ });
  for (const text of added) out.push({ type: "add", text, newNo: newNo++ });
  for (const text of a.slice(a.length - tail)) out.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  return { lines: out.slice(0, DIFF_LIMIT), added: added.length, removed: removed.length };
}

function editDiff(name: string, input: Record<string, unknown>) {
  if (name === "Write") {
    const content = lines(str(input.content));
    return {
      lines: content.slice(0, DIFF_LIMIT).map((text, i): DiffLine => ({ type: "add", text, newNo: i + 1 })),
      added: content.length,
      removed: 0,
    };
  }
  const edits = name === "MultiEdit" && Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
  const all: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    const diff = replacementDiff(str(edit.old_string), str(edit.new_string));
    if (edits.length > 1) all.push({ type: "hunk", text: "@@" });
    all.push(...diff.lines);
    added += diff.added;
    removed += diff.removed;
  }
  return { lines: all.slice(0, DIFF_LIMIT), added, removed };
}

function status(facts: ToolFacts): ToolStatus {
  if (facts.result) {
    if (!facts.result.isError) return "success";
    return facts.result.text.startsWith("Permission denied") ? "denied" : "error";
  }
  return facts.running ? "running" : "interrupted";
}

/** The first input value that describes the call, for tools without their own card. */
function describe(input: Record<string, unknown>, cwd?: string): string {
  for (const key of ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description", "skill", "prompt"]) {
    const value = str(input[key]);
    if (value) return key.endsWith("path") ? relative(value, cwd) : value.replace(/\s+/g, " ");
  }
  return "";
}

function card(name: string): { name: ToolName; label?: string; server?: string } {
  if (name.startsWith("mcp__")) {
    const [, server = "", ...tool] = name.split("__");
    return { name: "mcp", label: tool.join("__") || name, server };
  }
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "Bash":
    case "Grep":
    case "Glob":
    case "WebFetch":
    case "WebSearch":
    case "TodoWrite":
      return { name };
    case "MultiEdit":
      return { name: "Edit" };
    case "PowerShell":
      return { name: "Bash" };
    case "Agent":
    case "Task":
      return { name: "Task" };
    default:
      return { name: "other", label: name };
  }
}

/**
 * The shell tools answer the model with a header (command, sandbox, exit
 * code) and STDOUT/STDERR sections; the card shows the sections and the exit
 * code when it is not 0.
 */
function shellOutput(result: string, card: ToolCall): string {
  const exit = /^Exit code: (-?\d+)$/m.exec(result)?.[1];
  if (exit === undefined) return result;
  if (exit !== "0") card.summary = `退出码 ${exit}`;
  const section = (label: string) => new RegExp(`(?:^|\\n)${label}:\\n([\\s\\S]*?)(?=\\n(?:STDOUT|STDERR):\\n|$)`).exec(result)?.[1] ?? "";
  return [section("STDOUT"), section("STDERR")].filter(Boolean).join("\n").replace(/\n+$/, "");
}

/** Fold what is known about a call into the card the conversation shows. */
export function toolCall(facts: ToolFacts): ToolCall {
  const input = facts.input ?? {};
  const { name, label, server } = card(facts.name);
  const out: ToolCall = {
    id: facts.id,
    name,
    ...(label ? { label } : {}),
    ...(server ? { server } : {}),
    status: status(facts),
    target: "",
    startedAt: facts.startedAt ?? 0,
    ...(facts.startedAt && facts.completedAt ? { durationMs: facts.completedAt - facts.startedAt } : {}),
  };
  const result = facts.result?.text;

  switch (name) {
    case "Read": {
      out.target = relative(str(input.file_path), facts.cwd);
      if (result !== undefined && !facts.result?.isError) {
        // Read numbers each line ("  12\tcode"); notes the tool appends are not file lines.
        const all = lines(result);
        const numbered = all.filter((line) => /^\s*\d+\t/.test(line)).length;
        out.summary = `${numbered || all.length} 行`;
      }
      break;
    }
    case "Write":
    case "Edit": {
      out.target = relative(str(input.file_path), facts.cwd);
      if (facts.input) {
        const diff = editDiff(facts.name, input);
        out.diff = diff.lines;
        out.added = diff.added;
        out.removed = diff.removed;
      }
      if (facts.name === "Write" && result !== undefined && /^Created file:/.test(result)) out.created = true;
      break;
    }
    case "Bash":
      out.target = str(input.command);
      break;
    case "Grep":
      out.target = str(input.pattern);
      break;
    case "Glob": {
      out.target = str(input.pattern);
      if (result !== undefined && !facts.result?.isError && !/^No files found/.test(result)) out.summary = `${lines(result).length} 个文件`;
      break;
    }
    case "WebFetch":
      out.target = str(input.url);
      break;
    case "WebSearch":
      out.target = str(input.query);
      break;
    case "TodoWrite":
      out.target = Array.isArray(input.todos) ? `${input.todos.length} 项待办` : "待办清单";
      break;
    case "Task": {
      const progress = facts.subagent;
      out.target = str(input.description) || progress?.description || str(input.prompt).slice(0, 80);
      out.agent = {
        type: progress?.teammateName || str(input.subagent_type) || progress?.agentType || "general-purpose",
        steps: [],
        ...(progress ? { toolUses: progress.toolUseCount } : {}),
        ...(progress?.lastToolName ? { lastTool: progress.lastToolName } : {}),
        ...(progress?.totalTokens ? { tokens: progress.totalTokens } : {}),
        ...(result !== undefined && !facts.result?.isError ? { result } : {}),
      };
      return out;
    }
    default:
      out.target = describe(input, facts.cwd);
  }

  const output = facts.liveOutput ?? (name === "Bash" && result !== undefined ? shellOutput(result, out) : result);
  if (output && name !== "Write" && name !== "Edit") out.output = clip(output);
  else if (output && facts.result?.isError) out.output = clip(output);
  return out;
}

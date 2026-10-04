/**
 * Tool-call classification shared by the collapse logic (ConversationView)
 * and the card formatter (toolCardFormat).
 *
 * Two responsibilities:
 *   1. Decide whether a tool use is a read/search/list/MCP/memory operation
 *      that should collapse into a summary group, and which bucket it falls
 *      into (`classifyToolForCollapse`).
 *   2. Turn a raw Bash command into a human-readable card label —
 *      `Search`/`List`/`Test`/`Build`/`Git` instead of a bare `Bash`
 *      (`classifyBashLabel`).
 *
 * The Bash command buckets (search / read / list) decide which commands can
 * fold into a collapsed read/search group.
 */

// Search commands (grep, find, …) — pattern-matching across the tree.
const BASH_SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);

// Read/view commands (cat, head, …) plus the data-processing tools that
// commonly appear downstream of them in a pipe.
const BASH_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "strings",
  "jq",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
]);

// Directory-listing commands — kept separate so the summary can say
// "Listed N directories" instead of the misleading "Read N files".
const BASH_LIST_COMMANDS = new Set(["ls", "tree", "du"]);

// Semantic-neutral commands: pure output/status that doesn't change the
// read/search nature of a pipeline (e.g. `ls dir && echo --- && ls dir2`).
const BASH_SEMANTIC_NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

// Commands that typically produce no stdout on success — when they exit 0
// with empty output the UI shows "Done" instead of the misleading "(No
// output)".
const BASH_SILENT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "ln",
  "cd",
  "export",
  "unset",
  "wait",
]);

/** Collapse whitespace and truncate a shell command for the header line. */
export function shortenCommand(cmd: string, max = 72): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Split a compound command on shell operators (&&, ||, |, ;) into segments. */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** First token (base command) of a single segment, lowercased. */
function baseCommandOf(segment: string): string {
  return (segment.trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/**
 * Classify a Bash command as search / read / list for collapse purposes.
 * Every non-neutral segment
 * of a pipeline must itself be a search/read/list command, otherwise the
 * whole command is treated as a regular (non-collapsible) action.
 */
export function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean;
  isRead: boolean;
  isList: boolean;
} {
  const none = { isSearch: false, isRead: false, isList: false };
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return none;

  let hasSearch = false;
  let hasRead = false;
  let hasList = false;
  let hasNonNeutral = false;

  for (const segment of segments) {
    const base = baseCommandOf(segment);
    if (!base) continue;
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(base)) continue;
    hasNonNeutral = true;

    const isPartSearch = BASH_SEARCH_COMMANDS.has(base);
    const isPartRead = BASH_READ_COMMANDS.has(base);
    const isPartList = BASH_LIST_COMMANDS.has(base);

    // A single non-search/read/list segment poisons the whole command.
    if (!isPartSearch && !isPartRead && !isPartList) return none;

    if (isPartSearch) hasSearch = true;
    if (isPartRead) hasRead = true;
    if (isPartList) hasList = true;
  }

  if (!hasNonNeutral) return none;
  return { isSearch: hasSearch, isRead: hasRead, isList: hasList };
}

/**
 * True when EVERY non-neutral segment of a command is expected to be silent
 * on success (so empty output → "Done" rather than "(No output)").
 */
export function isSilentBashCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return false;
  let hasNonNeutral = false;
  for (const segment of segments) {
    const base = baseCommandOf(segment);
    if (!base) continue;
    if (BASH_SEMANTIC_NEUTRAL_COMMANDS.has(base)) continue;
    hasNonNeutral = true;
    if (!BASH_SILENT_COMMANDS.has(base)) return false;
  }
  return hasNonNeutral;
}

/** A collapse bucket: which "kind" of read-ish operation a tool use is. */
export type CollapseKind = "search" | "read" | "list" | "mcp" | "memoryWrite";

/** True when a tool name is a dynamic MCP tool (`mcp__server__tool`). */
function isMcpToolName(name: string): boolean {
  return name === "ListMcpResources" || name === "ReadMcpResource" || name.startsWith("mcp__");
}

/** Extract the MCP server name from a tool use, when discoverable. */
export function mcpServerNameOf(name: string, input: Record<string, unknown> | undefined): string | undefined {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[1];
  }
  const server = input?.["server"];
  return typeof server === "string" && server.length > 0 ? server : undefined;
}

/**
 * Decide whether a tool use collapses into a read/search summary group, and
 * which bucket it lands in. Returns null for non-collapsible tools (Edit,
 * Write, Bash actions like `npm test`, Agent, …), which break a run.
 *
 * Bucket precedence for Bash: list → search
 * → read (a `cat file | grep x` pipe is reported as a search).
 */
export function classifyToolForCollapse(name: string, input: Record<string, unknown> | undefined): CollapseKind | null {
  if (isMcpToolName(name)) return "mcp";
  switch (name) {
    case "Read":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "MemoryWrite":
      return "memoryWrite";
    case "Bash":
    case "PowerShell": {
      const command = input?.["command"];
      if (typeof command !== "string") return null;
      const { isSearch, isRead, isList } = isSearchOrReadBashCommand(command);
      if (isList) return "list";
      if (isSearch) return "search";
      if (isRead) return "read";
      return null;
    }
    default:
      return null;
  }
}

/** Pluralize a count with the right noun (e.g. 1 → "file", 3 → "files"). */
function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Aggregate counts that feed the collapsed-group summary line. */
export interface CollapsedCounts {
  searchCount: number;
  readCount: number;
  listCount: number;
  mcpCount: number;
  memoryWriteCount: number;
  /** Distinct MCP server names seen in the group, for "Queried slack …". */
  mcpServerName?: string;
}

/**
 * Build the one-line summary for a collapsed read/search group. The tense
 * switches by whether the group is still active:
 *   - active (some calls in flight) → present participle + trailing "…",
 *     e.g. "Searching 3 patterns · Reading 5 files…"
 *   - done (all results landed)     → past tense,
 *     e.g. "Searched 3 patterns · Read 5 files"
 *
 * Live grouping (ToolCallList) renders the active variant; the archived history
 * card (ConversationView) always renders the done variant.
 */
export function getCollapsedSummaryText(counts: CollapsedCounts, isActive = false): string {
  const v = (active: string, done: string): string => (isActive ? active : done);
  const parts: string[] = [];
  if (counts.searchCount > 0) {
    parts.push(`${v("Searching", "Searched")} ${plural(counts.searchCount, "pattern", "patterns")}`);
  }
  if (counts.readCount > 0) {
    parts.push(`${v("Reading", "Read")} ${plural(counts.readCount, "file", "files")}`);
  }
  if (counts.listCount > 0) {
    parts.push(`${v("Listing", "Listed")} ${plural(counts.listCount, "directory", "directories")}`);
  }
  if (counts.mcpCount > 0) {
    const who = counts.mcpServerName ?? "MCP";
    parts.push(`${v("Querying", "Queried")} ${who} ${counts.mcpCount === 1 ? "1 time" : `${counts.mcpCount} times`}`);
  }
  if (counts.memoryWriteCount > 0) {
    parts.push(`${v("Writing", "Wrote")} ${plural(counts.memoryWriteCount, "memory", "memories")}`);
  }
  const text = parts.join(" · ");
  return isActive && text ? `${text}…` : text;
}

// ---------------------------------------------------------------------------
// Bash semantic card labels (Search / List / Test / Build / Git / Bash).
// ---------------------------------------------------------------------------

/** Tokenize a command honouring simple single/double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/** Pull the search pattern out of a grep/rg/ag/ack command, if any. */
function extractSearchPattern(command: string): string | undefined {
  const tokens = tokenize(command);
  // Drop the binary, then take the first argument that isn't a flag.
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("-")) {
      // `-e PATTERN` / `--regexp PATTERN`: the next token is the pattern.
      if (tok === "-e" || tok === "--regexp") {
        const next = tokens[i + 1];
        if (next) return next;
      }
      continue;
    }
    return tok;
  }
  return undefined;
}

function isTestCommand(cmd: string): boolean {
  return (
    /\b(vitest|jest|mocha|pytest|ava)\b/.test(cmd) ||
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(cmd) ||
    /\bgo\s+test\b/.test(cmd) ||
    /\bcargo\s+test\b/.test(cmd) ||
    /\bpython\s+-m\s+pytest\b/.test(cmd)
  );
}

function isBuildCommand(cmd: string): boolean {
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(cmd) ||
    /\btsc\b/.test(cmd) ||
    /\bmake\b/.test(cmd) ||
    /\bcargo\s+build\b/.test(cmd) ||
    /\bgo\s+build\b/.test(cmd) ||
    /\bvite\s+build\b/.test(cmd) ||
    /\bwebpack\b/.test(cmd)
  );
}

/**
 * Map a raw Bash command to a human-readable card label + target. The label
 * names the *intent* of the command (Build/Test/Git/Search/List) so a wall of
 * `Bash(…)` cards reads as a sequence of recognizable actions. Anything that
 * doesn't match a known category stays a plain `Bash`.
 */
export function classifyBashLabel(command: string): { label: string; target?: string } {
  const trimmed = command.trim();
  if (!trimmed) return { label: "Bash" };
  const base = baseCommandOf(trimmed);

  // Git / GitHub / GitLab CLIs — strip the leading binary so the target reads
  // as the operation (`Git(status)`, `Git(pr create)`) rather than `Git(git …)`.
  if (base === "git" || base === "gh" || base === "glab") {
    const remainder = trimmed.slice(base.length).trim();
    return { label: "Git", target: shortenCommand(remainder || trimmed) };
  }

  // Test / build runners are recognized anywhere in the command (covers
  // `npm run build`, `CI=1 vitest run`, etc.). Test takes precedence so that
  // `npm test` isn't mis-bucketed by a stray "build" elsewhere.
  if (isTestCommand(trimmed)) return { label: "Test", target: shortenCommand(trimmed) };
  if (isBuildCommand(trimmed)) return { label: "Build", target: shortenCommand(trimmed) };

  if (BASH_SEARCH_COMMANDS.has(base)) {
    const pattern = extractSearchPattern(trimmed);
    return { label: "Search", target: pattern ? `"${pattern}"` : shortenCommand(trimmed) };
  }
  if (BASH_LIST_COMMANDS.has(base)) {
    return { label: "List", target: shortenCommand(trimmed) };
  }

  return { label: "Bash", target: shortenCommand(trimmed) };
}

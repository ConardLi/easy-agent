import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInput } from "ink";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { PermissionDecision, PermissionMode } from "../../permissions/permissions.js";
import type { TaskMode } from "../../state/taskModeStore.js";
import type { CommandSuggestion, FileSuggestion } from "../types.js";
import { useTextInput } from "./useTextInput.js";

export interface ModeSuggestion {
  key: string;
  mode: PermissionMode;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

export interface TaskModeSuggestion {
  key: string;
  mode: TaskMode;
  description: string;
  isCurrent: boolean;
  isSelected: boolean;
}

interface UsePromptInputOptions {
  isLoading: boolean;
  hasPermissionPrompt: boolean;
  /** True while an AskUserQuestion dialog owns the keyboard. */
  hasQuestionPrompt?: boolean;
  /** True while the Ctrl+O transcript overlay owns the keyboard. */
  hasTranscript?: boolean;
  /**
   * True while a slash-command result panel is pinned. Blocks all typing;
   * only Esc (→ `onDismissCommandPanel`) is honored.
   */
  hasCommandPanel?: boolean;
  /** Dismiss the command result panel (Esc). */
  onDismissCommandPanel?: () => void;
  isPlanExitPrompt: boolean;
  permissionMode: string;
  taskMode: TaskMode;
  /**
   * Extra `/` commands to merge into the suggestion list. Used for the
   * skill-registered commands (`/<skill-name>`) so the user sees them
   * alongside built-ins like /help, /skills, /mcp. The caller computes
   * this from the live skill registry on every render so newly-loaded
   * skills appear without restarting the suggestion machinery.
   */
  extraCommands?: CommandSuggestion[];
  /** Working directory used to resolve `@` file-reference typeahead. */
  cwd?: string;
  onSubmit: (text: string) => Promise<unknown> | unknown;
  onExit: () => void;
  onInterrupt: () => boolean;
  onPermissionDecision: (decision: PermissionDecision) => boolean;
  /** Ctrl+O — open the full-screen verbose transcript overlay. */
  onToggleTranscript: () => void;
}

const BUILTIN_COMMANDS: CommandSuggestion[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/config", description: "Inspect or change settings (list/get/set, --user/--project/--local)" },
  { name: "/cost", description: "Show session token usage" },
  { name: "/model", description: "Inspect current model or override it for this session" },
  { name: "/mode", description: "Inspect or switch permission mode (default/plan/auto)" },
  { name: "/tasks", description: "Switch task tracking system (task=persistent V2, todo=session V1)" },
  { name: "/mcp", description: "Inspect / reconnect MCP servers" },
  { name: "/skills", description: "List loaded skills (user + project scope)" },
  { name: "/agents", description: "List built-in + custom sub-agent definitions" },
  { name: "/hooks", description: "Show configured lifecycle hooks (user + project scope)" },
  { name: "/output-style", description: "Inspect or switch the answer style (default/Explanatory/Learning)" },
  { name: "/history", description: "Show saved sessions for this project" },
  { name: "/compact", description: "Compact the conversation context" },
  { name: "/exit", description: "Exit the session" },
];

const MODE_OPTIONS: { mode: PermissionMode; description: string }[] = [
  { mode: "default", description: "Confirm destructive operations" },
  { mode: "plan", description: "Read-only exploration, then plan" },
  { mode: "auto", description: "Auto-approve all operations" },
];

const TASK_MODE_OPTIONS: { mode: TaskMode; description: string }[] = [
  { mode: "task", description: "Persistent task graph (Task V2) — default" },
  { mode: "todo", description: "Session-memory todo list (TodoWrite V1)" },
];

// Max suggestions shown at once. Must comfortably exceed the built-in count
// (currently ~14) so a bare `/` still surfaces user-defined commands +
// skills, not just the first screenful of built-ins. Anything past this is
// summarized as "+N more" so a large skill set can't flood the terminal.
const MAX_SUGGESTIONS = 20;
const MAX_FILE_SUGGESTIONS = 10;

// A single input chunk this big is treated as a paste and folded into a
// reference token instead of being inserted verbatim (Ink delivers bracketed
// pastes as one `input` string).
const PASTE_MIN_LINES = 4;
const PASTE_MIN_CHARS = 800;

function isLargePaste(input: string): boolean {
  const lines = (input.match(/\n/g)?.length ?? 0) + 1;
  return lines >= PASTE_MIN_LINES || input.length >= PASTE_MIN_CHARS;
}

/**
 * Find the `@…` reference token the cursor is currently inside. A token runs
 * from the last whitespace before the cursor up to the cursor; it qualifies
 * only when it starts with `@`. Returns the token's start offset and the query
 * (everything after the `@`), or null when the cursor isn't on a reference.
 */
function findFileToken(
  value: string,
  cursor: number,
): { start: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) start--;
  const token = value.slice(start, cursor);
  if (!token.startsWith("@")) return null;
  return { start, query: token.slice(1) };
}

/** List files/dirs matching a `@`-typeahead query, relative to `cwd`. */
function computeFileSuggestions(query: string, cwd: string): FileSuggestion[] {
  // Split the query into a directory part and a basename prefix:
  //   "src/ui/Inp" → dir "src/ui", prefix "Inp"
  //   "src/"       → dir "src",   prefix ""
  //   "Inp"        → dir ".",     prefix "Inp"
  const slash = query.lastIndexOf("/");
  const dirPart = slash >= 0 ? query.slice(0, slash) : "";
  const prefix = slash >= 0 ? query.slice(slash + 1) : query;
  const absDir = path.resolve(cwd, dirPart || ".");
  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
  const lower = prefix.toLowerCase();
  return entries
    .filter((e) => !e.name.startsWith(".") || prefix.startsWith("."))
    .filter((e) => e.name.toLowerCase().startsWith(lower))
    .sort((a, b) => {
      // Directories first, then alphabetical.
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_FILE_SUGGESTIONS)
    .map((e) => {
      const rel = dirPart ? `${dirPart}/${e.name}` : e.name;
      return {
        path: e.isDirectory ? `${rel}/` : rel,
        isDirectory: e.isDirectory,
      };
    });
}

export function usePromptInput({
  isLoading,
  hasPermissionPrompt,
  hasQuestionPrompt,
  hasTranscript,
  hasCommandPanel,
  onDismissCommandPanel,
  isPlanExitPrompt,
  permissionMode,
  taskMode,
  extraCommands,
  cwd,
  onSubmit,
  onExit,
  onInterrupt,
  onPermissionDecision,
  onToggleTranscript,
}: UsePromptInputOptions) {
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [selectedModeIndex, setSelectedModeIndex] = useState(-1);
  const [selectedTaskModeIndex, setSelectedTaskModeIndex] = useState(-1);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);

  // Prompt history: submitted entries oldest→newest. `historyPos` walks the
  // list (== length means "current draft"); `draft` preserves the in-progress
  // line so ↓ back past the newest entry restores what the user was typing.
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef<number>(0);
  const draftRef = useRef<string>("");

  // Large-paste handling: a big pasted blob is replaced in the buffer by a
  // compact `[Pasted text #N +M lines]` token (so it doesn't flood the input);
  // the real content is stashed here and spliced back in at submit time.
  const pasteMapRef = useRef<Map<number, string>>(new Map());
  const pasteCounterRef = useRef(0);

  const expandPastes = useCallback((text: string): string => {
    if (pasteMapRef.current.size === 0) return text;
    return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, n) => {
      const stored = pasteMapRef.current.get(Number(n));
      return stored ?? m;
    });
  }, []);

  // Run-time input queue: while a turn is running the user can keep typing and
  // hit Enter; the message is parked here and auto-sent when the turn ends.
  const [queued, setQueued] = useState<string[]>([]);
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  const handleSubmit = useCallback(
    (rawText: string) => {
      // Splice any pasted blobs back in before the message leaves the editor.
      const text = expandPastes(rawText);
      pasteMapRef.current.clear();
      const trimmed = text.trim();
      if (!trimmed && isLoadingRef.current) {
        // Don't queue empty lines.
        textInput.clear();
        return;
      }
      if (trimmed) {
        const hist = historyRef.current;
        if (hist[hist.length - 1] !== text) hist.push(text);
      }
      historyPosRef.current = historyRef.current.length;
      draftRef.current = "";
      textInput.clear();
      if (isLoadingRef.current) {
        // A turn is in flight — park the message; the drain effect sends it.
        setQueued((q) => [...q, text]);
        return;
      }
      void onSubmit(text);
    },
    // textInput defined just below; stable identity via useCallback there.
    [onSubmit, expandPastes], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Drain the queue when the turn ends. Submitting one message starts a new
  // turn (isLoading flips back true), so the next queued item waits for the
  // following idle edge — strict FIFO, one per turn.
  const prevLoadingRef = useRef(isLoading);
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading && queued.length > 0) {
      const [next, ...rest] = queued;
      setQueued(rest);
      if (next !== undefined) void onSubmit(next);
    }
    prevLoadingRef.current = isLoading;
  }, [isLoading, queued, onSubmit]);

  const onHistoryPrev = useCallback((current: string): string | null => {
    const hist = historyRef.current;
    if (hist.length === 0) return null;
    if (historyPosRef.current === hist.length) draftRef.current = current;
    if (historyPosRef.current === 0) return null;
    historyPosRef.current -= 1;
    return hist[historyPosRef.current] ?? null;
  }, []);

  const onHistoryNext = useCallback((_current: string): string | null => {
    const hist = historyRef.current;
    if (historyPosRef.current >= hist.length) return null;
    historyPosRef.current += 1;
    if (historyPosRef.current === hist.length) return draftRef.current;
    return hist[historyPosRef.current] ?? null;
  }, []);

  const textInput = useTextInput({
    onHistoryPrev,
    onHistoryNext,
    onSubmit: handleSubmit,
  });
  const inputValue = textInput.value;
  const setInputValue = textInput.setValue;
  const cursorPos = textInput.cursor;

  // `@` file-reference typeahead. Recomputed whenever the buffer or cursor
  // moves; a fresh readdir per keystroke is cheap for a local CLI.
  const fileToken = useMemo(
    () => findFileToken(inputValue, cursorPos),
    [inputValue, cursorPos],
  );
  const fileSuggestionsRaw = useMemo(() => {
    if (!fileToken) return [];
    return computeFileSuggestions(fileToken.query, cwd ?? process.cwd());
  }, [fileToken, cwd]);
  const showFileSuggestions = fileSuggestionsRaw.length > 0;

  const acceptFileSuggestion = useCallback(
    (suggestion: FileSuggestion) => {
      if (!fileToken) return;
      const before = inputValue.slice(0, fileToken.start);
      const after = inputValue.slice(cursorPos);
      const inserted = `@${suggestion.path}`;
      const next = before + inserted + after;
      // Cursor lands right after the inserted reference. Directories keep their
      // trailing "/" so the palette stays open and the user can drill down.
      textInput.setValueAndCursor(next, before.length + inserted.length);
    },
    [fileToken, inputValue, cursorPos, textInput],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }
    // A slash-command result panel owns the screen: typing is suppressed and
    // only Esc dismisses it (mirrors Claude's local-jsx commands hiding the
    // prompt input). Sits before everything else so no keystroke leaks through.
    if (hasCommandPanel) {
      if (key.escape) onDismissCommandPanel?.();
      return;
    }
    // Esc interrupts the running turn (Claude's "esc to interrupt"). Only while
    // loading and when no overlay owns the keyboard — those handle Esc first.
    if (
      key.escape &&
      isLoading &&
      !hasPermissionPrompt &&
      !hasQuestionPrompt &&
      !hasTranscript
    ) {
      onInterrupt();
      return;
    }

    // The transcript overlay owns the keyboard (scroll + close) — useTranscript
    // handles everything, so swallow input here to avoid double-handling Ctrl+O.
    if (hasTranscript) {
      return;
    }
    // Ctrl+O opens the full-screen transcript. Works in any state. Ink delivers
    // Ctrl+O as input "o" with the ctrl modifier; \x0f is the raw fallback.
    if ((key.ctrl && input === "o") || input === "\x0f") {
      onToggleTranscript();
      return;
    }

    // An AskUserQuestion dialog owns the keyboard — useQuestionPrompt handles
    // arrows / Enter / Esc. Swallow everything else here so typing doesn't
    // leak into the (hidden) prompt buffer behind the dialog.
    if (hasQuestionPrompt) {
      return;
    }

    if (hasPermissionPrompt) {
      const normalized = input.toLowerCase();
      if (isPlanExitPrompt) {
        if (normalized === "y") {
          onPermissionDecision("allow_clear_context");
        } else if (normalized === "k") {
          onPermissionDecision("allow_once");
        } else if (normalized === "n") {
          onPermissionDecision("deny");
        }
      } else {
        if (normalized === "y") {
          onPermissionDecision("allow_once");
        } else if (normalized === "n") {
          onPermissionDecision("deny");
        } else if (normalized === "a") {
          onPermissionDecision("allow_always");
        }
      }
      return;
    }

    // Large paste → reference placeholder (works whether or not a turn runs).
    // Keeps a pasted 500-line log from flooding the input box; the real text is
    // spliced back at submit time.
    if (input && !key.ctrl && !key.meta && isLargePaste(input)) {
      const lineCount = input.split("\n").length;
      const id = ++pasteCounterRef.current;
      pasteMapRef.current.set(id, input);
      const token = `[Pasted text #${id} +${lineCount} lines]`;
      const before = inputValue.slice(0, cursorPos);
      const after = inputValue.slice(cursorPos);
      textInput.setValueAndCursor(before + token + after, before.length + token.length);
      return;
    }

    // While a turn runs, still allow editing + Enter — but route straight to
    // the line editor (Enter enqueues via handleSubmit). Skip the palettes so
    // arrow keys don't fight a half-relevant suggestion list mid-turn.
    if (isLoading) {
      textInput.handleKey(input, key);
      return;
    }

    // `@` file typeahead: arrows to move, Enter/Tab to accept, Esc to dismiss.
    // Takes priority over the line editor so ↑↓ navigate the list instead of
    // jumping history. Typing keeps flowing to the editor (filters the list).
    if (showFileSuggestions) {
      if (key.upArrow) {
        setSelectedFileIndex((prev) => (prev <= 0 ? fileSuggestionsRaw.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedFileIndex((prev) => (prev >= fileSuggestionsRaw.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return || key.tab) {
        const selected = fileSuggestionsRaw[selectedFileIndex] ?? fileSuggestionsRaw[0];
        if (selected) {
          acceptFileSuggestion(selected);
          setSelectedFileIndex(0);
          return;
        }
      }
      // fall through: printable keys / backspace edit the query and re-filter
    }

    // Command suggestions: arrows navigate (auto-selected at 0), Tab completes
    // the name (stay to add args), Enter runs the highlighted command — except
    // /mode and /tasks, which complete-then-open their dedicated selectors.
    if (showCommandSuggestions) {
      const eff =
        selectedCommandIndex < 0 || selectedCommandIndex >= filteredCommands.length
          ? 0
          : selectedCommandIndex;
      if (key.upArrow) {
        setSelectedCommandIndex(eff <= 0 ? filteredCommands.length - 1 : eff - 1);
        return;
      }
      if (key.downArrow) {
        setSelectedCommandIndex(eff >= filteredCommands.length - 1 ? 0 : eff + 1);
        return;
      }
      if (key.tab) {
        const selected = filteredCommands[eff];
        if (selected) {
          setInputValue(selected.name + " ");
          setSelectedCommandIndex(-1);
          return;
        }
      }
      if (key.return) {
        const selected = filteredCommands[eff];
        if (selected) {
          if (selected.name === "/mode" || selected.name === "/tasks") {
            // Complete to open the inline selector instead of running it bare.
            setInputValue(selected.name + " ");
          } else {
            // Run the highlighted command in one keystroke.
            handleSubmit(selected.name);
          }
          setSelectedCommandIndex(-1);
          return;
        }
      }
    }

    // Mode selector: arrow keys + Enter + number shortcuts
    if (showModeSelector) {
      if (key.upArrow) {
        setSelectedModeIndex((prev) => (prev <= 0 ? MODE_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedModeIndex((prev) => (prev >= MODE_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedModeIndex >= 0) {
        const selected = MODE_OPTIONS[selectedModeIndex];
        if (selected) {
          setInputValue("");
          setSelectedModeIndex(-1);
          void onSubmit(`/mode ${selected.mode}`);
          return;
        }
      }
      if (input === "1" || input === "2" || input === "3") {
        const idx = Number(input) - 1;
        const selected = MODE_OPTIONS[idx];
        if (selected) {
          setInputValue("");
          setSelectedModeIndex(-1);
          void onSubmit(`/mode ${selected.mode}`);
          return;
        }
      }
    }

    // Task-system selector: same UX as the permission-mode one, just two
    // options. Typing `1` or `2` submits directly so the user can flip
    // systems in two keystrokes (`/tasks` → `1`).
    if (showTaskModeSelector) {
      if (key.upArrow) {
        setSelectedTaskModeIndex((prev) => (prev <= 0 ? TASK_MODE_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedTaskModeIndex((prev) => (prev >= TASK_MODE_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedTaskModeIndex >= 0) {
        const selected = TASK_MODE_OPTIONS[selectedTaskModeIndex];
        if (selected) {
          setInputValue("");
          setSelectedTaskModeIndex(-1);
          void onSubmit(`/tasks ${selected.mode}`);
          return;
        }
      }
      if (input === "1" || input === "2") {
        const idx = Number(input) - 1;
        const selected = TASK_MODE_OPTIONS[idx];
        if (selected) {
          setInputValue("");
          setSelectedTaskModeIndex(-1);
          void onSubmit(`/tasks ${selected.mode}`);
          return;
        }
      }
    }

    // No palette / selector claimed the key — hand it to the line editor
    // (cursor movement, word/line kills, multi-line, history, submit).
    textInput.handleKey(input, key);
  });

  const showModeSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/mode" || trimmed === "/mode ";
    if (!show) {
      setSelectedModeIndex(-1);
    }
    return show;
  }, [inputValue]);

  const showTaskModeSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/tasks" || trimmed === "/tasks ";
    if (!show) {
      setSelectedTaskModeIndex(-1);
    }
    return show;
  }, [inputValue]);

  const filteredCommands = useMemo(() => {
    if (!inputValue.startsWith("/")) {
      return [];
    }
    // Once the user has typed an argument (`/model gpt`), stop suggesting —
    // they've committed to a command and are filling in its arguments.
    if (/\s/.test(inputValue.trim())) {
      return [];
    }
    // Built-ins first, then dynamic skill / user commands. De-dupe by name so
    // a project command that shadows a built-in doesn't appear twice.
    const seen = new Set<string>();
    const merged: CommandSuggestion[] = [];
    for (const cmd of [...BUILTIN_COMMANDS, ...(extraCommands ?? [])]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      merged.push(cmd);
    }
    // Query without the leading slash. Empty (`/`) → show everything.
    const query = inputValue.trim().slice(1).toLowerCase();
    if (!query) return merged.slice(0, MAX_SUGGESTIONS);

    // Rank by match quality: exact name → name-prefix → name-substring →
    // description-substring. Within a tier, shorter names sort first so the
    // closest command floats to the top (mirrors the source's Fuse ordering
    // without pulling in a fuzzy-search dependency).
    const ranked: { cmd: CommandSuggestion; score: number }[] = [];
    for (const cmd of merged) {
      const name = cmd.name.slice(1).toLowerCase();
      const desc = cmd.description.toLowerCase();
      let score: number;
      if (name === query) score = 0;
      else if (name.startsWith(query)) score = 1;
      else if (name.includes(query)) score = 2;
      else if (desc.includes(query)) score = 3;
      else continue;
      ranked.push({ cmd, score });
    }
    ranked.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.cmd.name.length !== b.cmd.name.length) return a.cmd.name.length - b.cmd.name.length;
      return a.cmd.name.localeCompare(b.cmd.name);
    });
    return ranked.map((r) => r.cmd).slice(0, MAX_SUGGESTIONS);
  }, [inputValue, extraCommands]);

  const showCommandSuggestions = filteredCommands.length > 0 && !showModeSelector && !showTaskModeSelector;

  const commandSuggestions: CommandSuggestion[] = useMemo(() => {
    if (!showCommandSuggestions) {
      setSelectedCommandIndex(-1);
      return [];
    }
    // Auto-select the first match so Enter/Tab work without arrowing first.
    const effective =
      selectedCommandIndex < 0 || selectedCommandIndex >= filteredCommands.length
        ? 0
        : selectedCommandIndex;
    return filteredCommands.map((item, i) => ({
      ...item,
      isSelected: i === effective,
    }));
  }, [showCommandSuggestions, filteredCommands, selectedCommandIndex]);

  const modeSuggestions: ModeSuggestion[] = useMemo(() => {
    if (!showModeSelector) return [];
    return MODE_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.mode,
      description: opt.description,
      isCurrent: opt.mode === permissionMode,
      isSelected: i === selectedModeIndex,
    }));
  }, [showModeSelector, permissionMode, selectedModeIndex]);

  const taskModeSuggestions: TaskModeSuggestion[] = useMemo(() => {
    if (!showTaskModeSelector) return [];
    return TASK_MODE_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.mode,
      description: opt.description,
      isCurrent: opt.mode === taskMode,
      isSelected: i === selectedTaskModeIndex,
    }));
  }, [showTaskModeSelector, taskMode, selectedTaskModeIndex]);

  const fileSuggestions: FileSuggestion[] = useMemo(() => {
    if (!showFileSuggestions) {
      if (selectedFileIndex !== 0) setSelectedFileIndex(0);
      return [];
    }
    const clamped =
      selectedFileIndex >= fileSuggestionsRaw.length ? 0 : selectedFileIndex;
    return fileSuggestionsRaw.map((item, i) => ({ ...item, isSelected: i === clamped }));
  }, [showFileSuggestions, fileSuggestionsRaw, selectedFileIndex]);

  return {
    inputValue,
    cursor: textInput.cursor,
    setInputValue,
    commandSuggestions,
    modeSuggestions,
    taskModeSuggestions,
    fileSuggestions,
    queued,
  };
}

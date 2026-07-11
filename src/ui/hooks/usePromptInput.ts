import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInput, usePaste } from "ink";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { PermissionDecision, PermissionMode } from "../../permissions/permissions.js";
import type { TaskMode } from "../../state/taskModeStore.js";
import type { CommandSuggestion, FileSuggestion } from "../types.js";
import { rm } from "node:fs/promises";
import { useTextInput } from "./useTextInput.js";
import { readClipboardImage } from "../utils/screenshotClipboard.js";
import { parsePastedImagePath, readImageAsBlock } from "../../tools/imageUtils.js";
import { addPastedImage, imageRefToken } from "../../core/pastedImages.js";
import type { ImageBlock } from "../../types/message.js";
import {
  buildDefaultThinkingConfig,
  getSessionEffortLevel,
} from "../../utils/thinking.js";

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
  /**
   * True while the `/resume` session picker overlay owns the keyboard
   * (useResumePicker handles ↑↓/Enter/Esc). We swallow everything else so a
   * keystroke — notably a bare digit used to pick a row — can't leak into the
   * hidden prompt buffer and get sent to the model.
   */
  hasResumePicker?: boolean;
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
  /** Surface a transient notice (e.g. clipboard-image paste result). */
  onNotice?: (notice: { tone: "info" | "error"; title: string; body: string }) => void;
}

const BUILTIN_COMMANDS: CommandSuggestion[] = [
  { name: "/help", description: "Show available commands" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/config", description: "Inspect or change settings (list/get/set, --user/--project/--local)" },
  { name: "/cost", description: "Show session token usage" },
  { name: "/model", description: "Inspect current model or override it for this session" },
  { name: "/mode", description: "Inspect or switch permission mode (default/plan/auto)" },
  { name: "/think", description: "Control extended thinking (on/off/<budget>)" },
  { name: "/effort", description: "Set reasoning effort (low/medium/high/max, Anthropic)" },
  { name: "/tasks", description: "Switch task tracking system (task=persistent V2, todo=session V1)" },
  { name: "/mcp", description: "Inspect / reconnect MCP servers" },
  { name: "/skills", description: "List loaded skills (user + project scope)" },
  { name: "/agents", description: "List built-in + custom sub-agent definitions" },
  { name: "/hooks", description: "Show configured lifecycle hooks (user + project scope)" },
  { name: "/output-style", description: "Inspect or switch the answer style (default/Explanatory/Learning)" },
  { name: "/history", description: "Show saved sessions for this project" },
  { name: "/compact", description: "Compact the conversation context" },
  { name: "/rewind", description: "Restore files to a previous turn (alias: /checkpoint)" },
  { name: "/status", description: "Show a snapshot of the current session config" },
  { name: "/context", description: "Visualize context window usage by category" },
  { name: "/doctor", description: "Run an environment health check" },
  { name: "/copy", description: "Copy an assistant reply to the clipboard (/copy [n])" },
  { name: "/export", description: "Export the conversation to a Markdown file (/export [file])" },
  { name: "/resume", description: "List and switch to a saved session (/resume [n|id])" },
  { name: "/diff", description: "Show uncommitted git changes + recent agent edits (/diff [n])" },
  { name: "/init", description: "Analyze the repo and draft an AGENT.md (runs a model turn)" },
  { name: "/permissions", description: "List/add/remove allow & deny rules by layer (alias: /allowed-tools)" },
  { name: "/memory", description: "List AGENT.md + project memory files; edit one in $EDITOR (/memory edit <n>)" },
  { name: "/exit", description: "Exit the session" },
];

const MODE_OPTIONS: { mode: PermissionMode; description: string }[] = [
  { mode: "default", description: "Confirm destructive operations" },
  { mode: "plan", description: "Read-only exploration, then plan" },
  { mode: "auto", description: "AI classifier auto-approves safe operations" },
];

const TASK_MODE_OPTIONS: { mode: TaskMode; description: string }[] = [
  { mode: "task", description: "Persistent task graph (Task V2) — default" },
  { mode: "todo", description: "Session-memory todo list (TodoWrite V1)" },
];

// Stage 34: extended-thinking on/off selector (arrow-navigable like /mode).
// `/think <budget>` typed directly still works for an explicit token budget.
const THINK_OPTIONS: { value: string; description: string }[] = [
  { value: "on", description: "Enable extended thinking (adaptive)" },
  { value: "off", description: "Disable extended thinking" },
];

// Stage 34: reasoning-effort selector (Anthropic). `auto` clears the override.
const EFFORT_OPTIONS: { value: string; description: string }[] = [
  { value: "low", description: "Quick, minimal reasoning overhead" },
  { value: "medium", description: "Balanced reasoning" },
  { value: "high", description: "Comprehensive, deeper reasoning" },
  { value: "max", description: "Maximum reasoning (Opus 4.6 only)" },
  { value: "auto", description: "Clear the override (model default)" },
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
const PASTE_MIN_LINES = 12;
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
  hasResumePicker,
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
  onNotice,
}: UsePromptInputOptions) {
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(-1);
  const [selectedModeIndex, setSelectedModeIndex] = useState(-1);
  const [selectedTaskModeIndex, setSelectedTaskModeIndex] = useState(-1);
  const [selectedThinkIndex, setSelectedThinkIndex] = useState(-1);
  const [selectedEffortIndex, setSelectedEffortIndex] = useState(-1);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [selectedPermissionIndex, setSelectedPermissionIndex] = useState(0);

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
  // Guards against re-entrant clipboard reads while one is still in flight.
  const clipboardBusyRef = useRef(false);

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

  const choosePermissionOption = useCallback(
    (index: number) => {
      if (index === 0) onPermissionDecision("allow_once");
      else if (index === 1) onPermissionDecision("allow_always");
      else onPermissionDecision("deny");
    },
    [onPermissionDecision],
  );

  // Splice text in at the current caret, mirroring what the user sees. Reads
  // the *current* render's inputValue/cursorPos, so it must be called from an
  // event handler that runs synchronously after render (useInput / usePaste).
  const insertAtCursor = (text: string) => {
    spliceTokenInto(cursorPos, inputValue, text);
  };

  // Splice `token` into a captured `snapshot` at offset `at`. Used by the async
  // image paths (clipboard read / file read) where the live input value isn't
  // reachable from the resolved closure — we capture at insert-request time.
  const spliceTokenInto = (at: number, snapshot: string, token: string) => {
    const before = snapshot.slice(0, at);
    const after = snapshot.slice(at);
    textInput.setValueAndCursor(before + token + after, before.length + token.length);
  };

  // Stash a decoded image in the in-memory registry and drop a compact
  // `[Image #N]` chip into the editor — never a raw temp path. The bytes are
  // expanded into a real image block at submit time. Matches Claude Code's
  // pasted-image model and avoids the workspace allowed-roots check entirely.
  const attachImageBlock = (
    img: { block: ImageBlock; mediaType: string; bytes: number },
    at: number,
    snapshot: string,
    filename: string,
  ) => {
    const id = addPastedImage({ block: img.block, mediaType: img.mediaType, bytes: img.bytes, filename });
    spliceTokenInto(at, snapshot, `${imageRefToken(id)} `);
    onNotice?.({ tone: "info", title: "Image", body: `${filename} attached — press Enter to send.` });
  };

  // Read an image *file* (pasted path) into the registry and chip it in.
  const attachImageFromPath = (absPath: string, at: number, snapshot: string) => {
    void readImageAsBlock(absPath)
      .then((img) => {
        if (img.ok) {
          attachImageBlock(img, at, snapshot, path.basename(absPath));
        } else {
          onNotice?.({ tone: "error", title: "Image", body: img.error });
        }
      })
      .catch((err: unknown) => {
        onNotice?.({ tone: "error", title: "Image", body: err instanceof Error ? err.message : String(err) });
      });
  };

  // Pull an image off the system clipboard into the registry and chip it in.
  // Guarded against re-entrancy because the clipboard read is async
  // (osascript / pngpaste). The temp file is read then deleted — the bytes
  // live only in memory, so nothing leaks an unreadable path into the prompt.
  const grabClipboardImage = (at: number, snapshot: string) => {
    if (clipboardBusyRef.current) return;
    clipboardBusyRef.current = true;
    onNotice?.({ tone: "info", title: "Clipboard", body: "Reading image from clipboard…" });
    void readClipboardImage()
      .then(async (res) => {
        if (!res.ok) {
          onNotice?.({ tone: "error", title: "Clipboard", body: res.error });
          return;
        }
        const img = await readImageAsBlock(res.path);
        void rm(res.path, { force: true }).catch(() => {});
        if (img.ok) {
          attachImageBlock(img, at, snapshot, "Pasted image");
        } else {
          onNotice?.({ tone: "error", title: "Clipboard", body: img.error });
        }
      })
      .catch((err: unknown) => {
        onNotice?.({
          tone: "error",
          title: "Clipboard",
          body: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        clipboardBusyRef.current = false;
      });
  };

  // Bracketed-paste channel (Ink enables `\x1b[?2004h` while this is active).
  // This is the path that makes Cmd+V work on macOS: the terminal owns Cmd+V
  // and never lets it reach useInput, but it *does* forward the paste here.
  // Crucially, pasting a clipboard *image* with Cmd+V yields an EMPTY bracketed
  // paste (the terminal can't serialize the bitmap as text), which we treat as
  // "go read the image off the clipboard" — exactly how Claude Code does it.
  usePaste((text: string) => {
    // Overlays own the keyboard; don't leak pastes into the hidden buffer.
    if (hasCommandPanel || hasTranscript || hasPermissionPrompt || hasQuestionPrompt || hasResumePicker) {
      return;
    }

    // Empty paste = Cmd+V of a clipboard image (macOS). Grab it from the OS.
    if (text.length === 0) {
      if (process.platform === "darwin") grabClipboardImage(cursorPos, inputValue);
      return;
    }

    // Pasted an image *file* path (e.g. copied from Finder) → read it into the
    // registry and drop an `[Image #N]` chip (not the raw path).
    const imgPath = parsePastedImagePath(text);
    if (imgPath) {
      attachImageFromPath(imgPath, cursorPos, inputValue);
      return;
    }

    // Large paste → reference placeholder; real text is spliced back at submit.
    if (isLargePaste(text)) {
      const lineCount = text.split("\n").length;
      const id = ++pasteCounterRef.current;
      pasteMapRef.current.set(id, text);
      insertAtCursor(`[Pasted text #${id} +${lineCount} lines]`);
      return;
    }

    // Ordinary paste → insert verbatim at the caret.
    insertAtCursor(text);
  });

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
    // The /resume picker owns the keyboard (useResumePicker). Swallow all keys
    // here so a row-selecting digit or Enter never reaches the prompt buffer.
    if (hasResumePicker) {
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

    // Ctrl+V grabs a clipboard *image* explicitly. This is the cross-terminal
    // fallback: Cmd+V is preferred (handled by the bracketed-paste channel
    // above), but terminals that don't forward Cmd+V — or users on a keyboard
    // without it — get the same behavior here. Ink delivers Ctrl+V as "v"+ctrl
    // or the raw \x16 byte.
    if ((key.ctrl && input === "v") || input === "\x16") {
      grabClipboardImage(cursorPos, inputValue);
      return;
    }

    // An AskUserQuestion dialog owns the keyboard — useQuestionPrompt handles
    // arrows / Enter / Esc. Swallow everything else here so typing doesn't
    // leak into the (hidden) prompt buffer behind the dialog.
    if (hasQuestionPrompt) {
      return;
    }

    // Shift+Tab opens the permission-mode selector (the same keyboard-navigable
    // list `/mode` shows). Ink parses Shift+Tab (CSI "\x1b[Z") as key.tab +
    // key.shift. We deliberately DON'T submit `/mode <x>` directly: that emits a
    // blocking command panel that swallows the next keypress. Opening the
    // selector instead lets the user keep pressing Shift+Tab (or ↑/↓) to move
    // the highlight, then Enter / number to apply.
    if (key.tab && key.shift && !isLoading && !hasPermissionPrompt) {
      const currentIdx = MODE_OPTIONS.findIndex((o) => o.mode === permissionMode);
      const base = currentIdx < 0 ? 0 : currentIdx;
      if (showModeSelector) {
        // Already open: advance the highlight so repeated Shift+Tab cycles.
        setSelectedModeIndex((prev) => {
          const from = prev < 0 ? base : prev;
          return (from + 1) % MODE_OPTIONS.length;
        });
      } else {
        // Open it (mirrors typing "/mode ") and pre-highlight the next mode.
        setInputValue("/mode ");
        setSelectedModeIndex((base + 1) % MODE_OPTIONS.length);
      }
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
        if (key.escape) {
          onPermissionDecision("deny");
        } else if (key.upArrow) {
          setSelectedPermissionIndex((prev) => (prev <= 0 ? 2 : prev - 1));
        } else if (key.downArrow) {
          setSelectedPermissionIndex((prev) => (prev >= 2 ? 0 : prev + 1));
        } else if (key.return) {
          choosePermissionOption(selectedPermissionIndex);
        } else if (normalized === "y" || normalized === "1") {
          onPermissionDecision("allow_once");
        } else if (normalized === "a" || normalized === "2") {
          onPermissionDecision("allow_always");
        } else if (normalized === "n" || normalized === "3") {
          onPermissionDecision("deny");
        }
      }
      return;
    }

    // Pasted image path → `@path` token. On macOS, Cmd+V is handled by the
    // terminal as "paste"; copying an image *file* (Finder) then Cmd+V pastes
    // its path here. We convert a lone existing image path into an attachment
    // reference so it rides the same pipeline as a typed `@image.png`. A paste
    // arrives as a multi-char `input` chunk (not a single keystroke).
    if (input && input.length > 1 && !key.ctrl && !key.meta) {
      const imgPath = parsePastedImagePath(input);
      if (imgPath) {
        attachImageFromPath(imgPath, cursorPos, inputValue);
        return;
      }
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

    // Mode selector: arrow keys + Enter + number shortcuts. Esc closes it and
    // clears the "/mode " buffer so Shift+Tab → Esc leaves no stray text.
    if (showModeSelector) {
      if (key.escape) {
        setInputValue("");
        setSelectedModeIndex(-1);
        return;
      }
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

    // Extended-thinking selector: same arrow/Enter/number UX as /mode.
    if (showThinkSelector) {
      if (key.escape) {
        setInputValue("");
        setSelectedThinkIndex(-1);
        return;
      }
      if (key.upArrow) {
        setSelectedThinkIndex((prev) => (prev <= 0 ? THINK_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedThinkIndex((prev) => (prev >= THINK_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedThinkIndex >= 0) {
        const selected = THINK_OPTIONS[selectedThinkIndex];
        if (selected) {
          setInputValue("");
          setSelectedThinkIndex(-1);
          void onSubmit(`/think ${selected.value}`);
          return;
        }
      }
      if (input === "1" || input === "2") {
        const selected = THINK_OPTIONS[Number(input) - 1];
        if (selected) {
          setInputValue("");
          setSelectedThinkIndex(-1);
          void onSubmit(`/think ${selected.value}`);
          return;
        }
      }
    }

    // Reasoning-effort selector: arrow/Enter/number UX; 5 options (1-5).
    if (showEffortSelector) {
      if (key.escape) {
        setInputValue("");
        setSelectedEffortIndex(-1);
        return;
      }
      if (key.upArrow) {
        setSelectedEffortIndex((prev) => (prev <= 0 ? EFFORT_OPTIONS.length - 1 : prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedEffortIndex((prev) => (prev >= EFFORT_OPTIONS.length - 1 ? 0 : prev + 1));
        return;
      }
      if (key.return && selectedEffortIndex >= 0) {
        const selected = EFFORT_OPTIONS[selectedEffortIndex];
        if (selected) {
          setInputValue("");
          setSelectedEffortIndex(-1);
          void onSubmit(`/effort ${selected.value}`);
          return;
        }
      }
      if (/^[1-5]$/.test(input)) {
        const selected = EFFORT_OPTIONS[Number(input) - 1];
        if (selected) {
          setInputValue("");
          setSelectedEffortIndex(-1);
          void onSubmit(`/effort ${selected.value}`);
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

  const showThinkSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/think" || trimmed === "/think ";
    if (!show) {
      setSelectedThinkIndex(-1);
    }
    return show;
  }, [inputValue]);

  const showEffortSelector = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    const show = trimmed === "/effort" || trimmed === "/effort ";
    if (!show) {
      setSelectedEffortIndex(-1);
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

  const showCommandSuggestions =
    filteredCommands.length > 0 &&
    !showModeSelector &&
    !showTaskModeSelector &&
    !showThinkSelector &&
    !showEffortSelector;

  useEffect(() => {
    if (!hasPermissionPrompt && selectedPermissionIndex !== 0) {
      setSelectedPermissionIndex(0);
    }
  }, [hasPermissionPrompt, selectedPermissionIndex]);

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

  const thinkSuggestions = useMemo(() => {
    if (!showThinkSelector) return [];
    const currentOn = buildDefaultThinkingConfig().type !== "disabled";
    return THINK_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.value,
      description: opt.description,
      isCurrent: (opt.value === "on") === currentOn,
      isSelected: i === selectedThinkIndex,
    }));
  }, [showThinkSelector, selectedThinkIndex]);

  const effortSuggestions = useMemo(() => {
    if (!showEffortSelector) return [];
    const current = getSessionEffortLevel();
    return EFFORT_OPTIONS.map((opt, i) => ({
      key: String(i + 1),
      mode: opt.value,
      description: opt.description,
      isCurrent: opt.value === "auto" ? current === undefined : opt.value === current,
      isSelected: i === selectedEffortIndex,
    }));
  }, [showEffortSelector, selectedEffortIndex]);

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
    thinkSuggestions,
    effortSuggestions,
    fileSuggestions,
    selectedPermissionIndex,
    queued,
  };
}

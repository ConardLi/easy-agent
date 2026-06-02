/**
 * Step 24 - Rendering experience upgrades
 *
 * Goal:
 * - keep committed history stable and render only the live tail
 * - render streaming Markdown without flicker
 * - summarize tool results by default, expand them in transcript mode
 * - support a real prompt buffer, file mentions, and bash mode
 */

// -----------------------------------------------------------------------------
// 1. Static history + live region
// -----------------------------------------------------------------------------

export function splitStaticAndLive(messages) {
  const committed = [];
  let live = null;

  for (const message of messages) {
    if (message.status === "streaming" || message.status === "running") {
      live = message;
    } else {
      committed.push(message);
    }
  }

  return { committed, live };
}

export function renderConversationFrame(messages) {
  const { committed, live } = splitStaticAndLive(messages);
  return {
    staticLines: committed.flatMap(renderCommittedMessage),
    liveLines: live ? renderLiveMessage(live) : [],
  };
}

function renderCommittedMessage(message) {
  if (message.role === "assistant") return markdownToAnsiLines(message.content);
  if (message.role === "tool") return renderToolResult(message, { verbose: false });
  return [`> ${message.content}`];
}

function renderLiveMessage(message) {
  if (message.role === "assistant") return renderStreamingMarkdown(message.content);
  if (message.role === "tool") return renderToolResult(message, { verbose: false });
  return [`> ${message.content}`];
}

// -----------------------------------------------------------------------------
// 2. Streaming Markdown with a stable prefix
// -----------------------------------------------------------------------------

export function splitStablePrefix(content) {
  const text = String(content);
  const fenceMatches = text.match(/```/g) ?? [];

  if (fenceMatches.length % 2 === 1) {
    const lastFence = text.lastIndexOf("```");
    return { stable: text.slice(0, lastFence), tail: text.slice(lastFence) };
  }

  const lastParagraphBreak = text.lastIndexOf("\n\n");
  if (lastParagraphBreak < 0) return { stable: "", tail: text };

  return {
    stable: text.slice(0, lastParagraphBreak),
    tail: text.slice(lastParagraphBreak + 2),
  };
}

const markdownCache = new Map();

export function markdownToAnsiLines(markdown) {
  const key = String(markdown);
  const cached = markdownCache.get(key);
  if (cached) return cached;

  const lines = [];
  let inFence = false;
  let fenceLanguage = "";

  for (const rawLine of key.split(/\r?\n/)) {
    const fence = rawLine.match(/^```(\w+)?/);
    if (fence) {
      inFence = !inFence;
      fenceLanguage = inFence ? fence[1] || "text" : "";
      lines.push(inFence ? `┌─ ${fenceLanguage}` : "└─");
      continue;
    }

    if (inFence) {
      lines.push(`│ ${highlightCode(rawLine, fenceLanguage)}`);
      continue;
    }

    lines.push(renderMarkdownLine(rawLine));
  }

  markdownCache.set(key, lines);
  return lines;
}

export function renderStreamingMarkdown(content) {
  const { stable, tail } = splitStablePrefix(content);
  return [
    ...markdownToAnsiLines(stable),
    ...(stable && tail ? [""] : []),
    ...(tail ? tail.split(/\r?\n/) : []),
  ];
}

function renderMarkdownLine(line) {
  if (/^#{1,6}\s+/.test(line)) return line.replace(/^#{1,6}\s+/, "").toUpperCase();
  return line
    .replace(/\*\*([^*]+)\*\*/g, "\x1b[1m$1\x1b[22m")
    .replace(/`([^`]+)`/g, "\x1b[36m$1\x1b[39m");
}

function highlightCode(line, language) {
  if (!["js", "ts", "javascript", "typescript"].includes(language)) return line;
  return line.replace(/\b(const|let|function|return|await|async)\b/g, "\x1b[35m$1\x1b[39m");
}

// -----------------------------------------------------------------------------
// 3. Tool result summaries and transcript expansion
// -----------------------------------------------------------------------------

export function diffLines(oldText, newText) {
  const oldLines = String(oldText).split(/\r?\n/);
  const newLines = String(newText).split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const out = [];

  for (let i = 0; i < max; i += 1) {
    if (oldLines[i] === newLines[i]) {
      if (oldLines[i] !== undefined) out.push({ kind: "context", text: oldLines[i] });
      continue;
    }
    if (oldLines[i] !== undefined) out.push({ kind: "del", text: oldLines[i] });
    if (newLines[i] !== undefined) out.push({ kind: "add", text: newLines[i] });
  }

  return out;
}

export function diffStats(oldText, newText) {
  let added = 0;
  let removed = 0;
  for (const line of diffLines(oldText, newText)) {
    if (line.kind === "add") added += 1;
    if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export function formatDiffSummary(filePath, oldText, newText) {
  const stats = diffStats(oldText, newText);
  return `${filePath} +${stats.added} -${stats.removed}`;
}

export function formatUnifiedDiff(filePath, oldText, newText) {
  const rows = [`--- ${filePath}`, `+++ ${filePath}`];
  for (const line of diffLines(oldText, newText)) {
    const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    rows.push(`${prefix}${line.text}`);
  }
  return rows;
}

export function renderToolResult(toolCall, options = {}) {
  const verbose = options.verbose === true;

  if (toolCall.name === "Edit" || toolCall.name === "Write") {
    if (!verbose) {
      return [`● ${toolCall.name}`, `  ⎿ ${formatDiffSummary(toolCall.filePath, toolCall.oldText, toolCall.newText)}`];
    }
    return [`● ${toolCall.name}`, ...formatUnifiedDiff(toolCall.filePath, toolCall.oldText, toolCall.newText)];
  }

  if (toolCall.name === "Bash") {
    const lines = String(toolCall.output || "").split(/\r?\n/).filter(Boolean);
    const tail = verbose ? lines : lines.slice(-6);
    return [`● Bash ${toolCall.running ? "running" : "done"}`, ...tail.map((line) => `  ${line}`)];
  }

  if (["Read", "Grep", "Glob"].includes(toolCall.name)) {
    const targets = toolCall.targets || [toolCall.filePath || toolCall.pattern].filter(Boolean);
    if (!verbose) return [`● ${toolCall.name}`, `  ⎿ ${targets.join(", ")}`];
    return [`● ${toolCall.name}`, ...targets.map((target) => `  ${target}`), ...(toolCall.content ? [toolCall.content] : [])];
  }

  return [`● ${toolCall.name}`, String(toolCall.result || "")];
}

export function groupReadSearchTools(toolCalls) {
  const groups = [];
  let current = null;

  for (const call of toolCalls) {
    if (["Read", "Grep", "Glob"].includes(call.name) && call.ok !== false) {
      if (!current) {
        current = { type: "read-search", calls: [] };
        groups.push(current);
      }
      current.calls.push(call);
    } else {
      current = null;
      groups.push({ type: "single", call });
    }
  }

  return groups;
}

export function buildTranscriptLines(messages, search = "") {
  const lines = [];
  for (const message of messages) {
    if (message.role === "tool") {
      lines.push(...renderToolResult(message, { verbose: true }));
    } else if (message.role === "assistant") {
      lines.push(...markdownToAnsiLines(message.content));
    } else {
      lines.push(`> ${message.content}`);
    }
  }

  if (!search) return lines;
  return lines.map((line) =>
    line.toLowerCase().includes(search.toLowerCase()) ? `> ${line}` : `  ${line}`,
  );
}

// -----------------------------------------------------------------------------
// 4. Bash progress store
// -----------------------------------------------------------------------------

export function createBashProgressStore(maxLines = 200) {
  const entries = new Map();
  const subscribers = new Set();

  function notify(id) {
    const value = entries.get(id);
    for (const subscriber of subscribers) subscriber(id, value);
  }

  return {
    append(id, chunk, stream = "stdout") {
      const prev = entries.get(id) || {
        startedAt: Date.now(),
        stdout: [],
        stderr: [],
        lineCount: 0,
        running: true,
      };
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      const bucket = stream === "stderr" ? prev.stderr : prev.stdout;
      bucket.push(...lines);
      while (bucket.length > maxLines) bucket.shift();
      prev.lineCount += lines.length;
      entries.set(id, prev);
      notify(id);
    },
    finish(id, exitCode = 0) {
      const prev = entries.get(id);
      if (!prev) return;
      entries.set(id, { ...prev, running: false, exitCode, endedAt: Date.now() });
      notify(id);
    },
    get(id) {
      return entries.get(id);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

// -----------------------------------------------------------------------------
// 5. Prompt input buffer
// -----------------------------------------------------------------------------

export class TextInputBuffer {
  constructor(value = "") {
    this.value = value;
    this.cursor = value.length;
    this.history = [];
    this.historyIndex = null;
    this.draft = "";
  }

  insert(text) {
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
  }

  backspace() {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor -= 1;
  }

  moveLeft(word = false) {
    if (!word) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    while (this.cursor > 0 && /\s/.test(this.value[this.cursor - 1])) this.cursor -= 1;
    while (this.cursor > 0 && /\S/.test(this.value[this.cursor - 1])) this.cursor -= 1;
  }

  moveRight(word = false) {
    if (!word) {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    while (this.cursor < this.value.length && /\s/.test(this.value[this.cursor])) this.cursor += 1;
    while (this.cursor < this.value.length && /\S/.test(this.value[this.cursor])) this.cursor += 1;
  }

  killToLineStart() {
    const lineStart = this.value.lastIndexOf("\n", this.cursor - 1) + 1;
    this.value = this.value.slice(0, lineStart) + this.value.slice(this.cursor);
    this.cursor = lineStart;
  }

  killToLineEnd() {
    const nextNewline = this.value.indexOf("\n", this.cursor);
    const lineEnd = nextNewline < 0 ? this.value.length : nextNewline;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(lineEnd);
  }

  submit() {
    const submitted = this.value;
    if (submitted.trim()) this.history.push(submitted);
    this.value = "";
    this.cursor = 0;
    this.historyIndex = null;
    return submitted;
  }

  previousHistory() {
    if (!this.history.length) return this.value;
    if (this.historyIndex === null) {
      this.draft = this.value;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }
    this.value = this.history[this.historyIndex];
    this.cursor = this.value.length;
    return this.value;
  }

  nextHistory() {
    if (this.historyIndex === null) return this.value;
    this.historyIndex += 1;
    if (this.historyIndex >= this.history.length) {
      this.historyIndex = null;
      this.value = this.draft;
    } else {
      this.value = this.history[this.historyIndex];
    }
    this.cursor = this.value.length;
    return this.value;
  }

  mode() {
    return this.value.trimStart().startsWith("!") ? "bash" : "prompt";
  }

  currentMentionToken() {
    const left = this.value.slice(0, this.cursor);
    const token = left.split(/\s/).at(-1) || "";
    return token.startsWith("@") ? token.slice(1) : null;
  }
}

export function computeFileSuggestions(files, token, limit = 8) {
  const prefix = String(token || "");
  return files
    .filter((file) => file.startsWith(prefix))
    .sort((a, b) => Number(!a.endsWith("/")) - Number(!b.endsWith("/")) || a.localeCompare(b))
    .slice(0, limit);
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep24() {
  const stream = "Here is a plan\n\n```ts\nconst answer = 42";
  const progress = createBashProgressStore();
  progress.append("tool-1", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  progress.finish("tool-1");

  const input = new TextInputBuffer("explain @src/");
  const mention = input.currentMentionToken();
  const suggestions = computeFileSuggestions(["src/index.ts", "src/ui/", "README.md"], mention);

  const messages = [
    { role: "user", content: "update the UI", status: "done" },
    {
      role: "tool",
      name: "Edit",
      filePath: "src/App.tsx",
      oldText: "return <Text>old</Text>;",
      newText: "return <Text>new</Text>;",
      status: "done",
    },
    { role: "assistant", content: stream, status: "streaming" },
  ];

  return {
    stablePrefix: splitStablePrefix(stream),
    frame: renderConversationFrame(messages),
    bashTail: progress.get("tool-1").stdout.slice(-6),
    diffSummary: formatDiffSummary("src/App.tsx", "old\n", "new\nmore\n"),
    suggestions,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await demoStep24(), null, 2));
}

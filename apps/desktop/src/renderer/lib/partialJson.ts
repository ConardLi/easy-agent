/**
 * Parse JSON the model has not finished writing, such as a tool call's input
 * while it streams. An open string is closed where it stops, open objects and
 * arrays are closed, and a key or value cut off midway is dropped. Returns
 * undefined when nothing usable is there yet.
 */
export function parsePartialJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Unfinished; complete it below.
  }
  const closers: string[] = [];
  /** Prefixes that end right after a complete value or an opening bracket, with the brackets open there. */
  const cuts: { at: number; close: string }[] = [];
  const closeAll = () => [...closers].reverse().join("");
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") {
      closers.push(c === "{" ? "}" : "]");
      cuts.push({ at: i + 1, close: closeAll() });
    } else if (c === "}" || c === "]") {
      closers.pop();
      cuts.push({ at: i + 1, close: closeAll() });
    } else if (c === ",") cuts.push({ at: i, close: closeAll() });
  }

  const attempt = (candidate: string): { value: unknown } | null => {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      return null;
    }
  };
  if (inString) {
    // Drop a dangling escape so the closing quote is not escaped.
    const body = (escaped ? text.slice(0, -1) : text).replace(/\\u[0-9a-fA-F]{0,3}$/, "");
    const closed = attempt(`${body}"${closeAll()}`);
    if (closed) return closed.value;
  } else {
    const closed = attempt(text.trimEnd() + closeAll());
    if (closed) return closed.value;
  }
  for (let k = cuts.length - 1; k >= 0; k--) {
    const { at, close } = cuts[k]!;
    const cut = attempt(text.slice(0, at) + close);
    if (cut) return cut.value;
  }
  return undefined;
}

/** The fields of a tool call's input written so far. */
export function partialInput(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const value = parsePartialJson(text);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

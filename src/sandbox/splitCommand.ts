/** Split top-level shell command lists while preserving quoted operators. */

const OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

export function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let buffer = "";
  let quote: string | null = null;
  let i = 0;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) segments.push(trimmed);
    buffer = "";
  };

  while (i < command.length) {
    const ch = command[i]!;

    // Quoted regions are passed through opaquely. We only honor the
    // matching closing quote — escapes inside quotes are not handled
    // (see top-comment for trade-off rationale).
    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      i += 1;
      continue;
    }

    // Two-char operators take priority over single-char ones to avoid
    // splitting `&&` as two `&` background operators (which would also
    // be wrong: `&` runs in background, `&&` is conditional-and).
    const two = command.slice(i, i + 2);
    if (OPERATORS.has(two)) {
      flush();
      i += 2;
      continue;
    }

    if (OPERATORS.has(ch)) {
      flush();
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return segments;
}

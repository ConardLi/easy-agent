/**
 * Lightweight bash compound-command splitter.
 *
 * Why we need this: the auto-allow path checks each subcommand of
 * `echo a && rm -rf /` against deny rules. If we matched only the head
 * of the full command string, `Bash(rm:*)` would not catch the second
 * subcommand and the deny rule would silently fail. See the SECURITY
 * comment in source code's `bashPermissions.ts:1295`.
 *
 * Compared to source code's `splitCommand_DEPRECATED` (which uses
 * `shell-quote` to do real parsing including redirects, heredocs, and
 * parameter substitution), our version is intentionally minimal:
 *
 *   - We split on the four standard logical operators: `&&`, `||`,
 *     `;`, `|` and the `&` background operator.
 *   - We respect single + double quotes — `echo "a && b"` is one
 *     subcommand, not three.
 *   - We do NOT understand subshells `(...)`, command substitution
 *     `$(...)`, heredocs `<<EOF`, or escapes inside double quotes.
 *
 * For the easy-agent threat model this is enough: even if a model
 * crafts an exotic command that tricks the splitter, the worst case
 * is "we run one extra deny-check" or "we miss a deny rule on a
 * cleverly-quoted subcommand" — and the sandbox itself still
 * enforces the kernel-level filesystem/network restrictions.
 */

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

/**
 * Placeholder substitution for user-command prompt templates.
 *
 * Supported placeholders:
 *   - $ARGUMENTS        → the full raw argument string
 *   - $ARGUMENTS[0..n]  → individual arguments, ZERO-indexed (array notation)
 *   - $1, $2, …         → positional arguments, ONE-indexed (shell / Claude
 *                         Code convention: $1 is the FIRST argument)
 *
 * When the template contains NO placeholder but the user passed arguments,
 * we append "ARGUMENTS: <args>" so the model still sees them.
 *
 * A small hand-rolled shell-style tokenizer handles indexed access
 * (single/double quotes) without pulling in a shell-parsing dependency.
 */

/**
 * Split an arguments string into tokens, honouring single and double quotes
 * so `"hello world"` stays one token. Unterminated quotes degrade to a plain
 * whitespace split rather than throwing.
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) return [];

  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let sawToken = false;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (sawToken) {
        tokens.push(current);
        current = "";
        sawToken = false;
      }
      continue;
    }
    current += ch;
    sawToken = true;
  }
  if (sawToken) tokens.push(current);

  // Unterminated quote → fall back to a simple whitespace split.
  if (quote) return args.split(/\s+/).filter(Boolean);
  return tokens;
}

/**
 * Substitute placeholders in `content` with values from `args`.
 *
 * @param content The prompt template.
 * @param args    Raw argument string. `undefined` means "no args provided"
 *                and returns the content unchanged.
 * @param appendIfNoPlaceholder When true and the template had no placeholder
 *                but args were passed, append "ARGUMENTS: <args>".
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
): string {
  if (args === undefined || args === null) return content;

  const parsed = parseArguments(args);
  const original = content;

  // $ARGUMENTS[n] — zero-indexed array notation.
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx: string) => parsed[Number(idx)] ?? "");
  // $1, $2, … — one-indexed positional args (shell convention: $1 = first).
  // Guard against matching $1abc by requiring a non-word boundary.
  content = content.replace(/\$(\d+)(?!\w)/g, (_, idx: string) => {
    const n = Number(idx);
    return n >= 1 ? parsed[n - 1] ?? "" : "";
  });
  // $ARGUMENTS (full string) — replace last so it doesn't eat the indexed forms.
  content = content.replaceAll("$ARGUMENTS", args);

  if (content === original && appendIfNoPlaceholder && args.trim()) {
    content = `${content}\n\nARGUMENTS: ${args}`;
  }
  return content;
}

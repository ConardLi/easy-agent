/**
 * Shared string-edit core for the Edit and MultiEdit tools.
 *
 * Reference: claude-code-source-code/src/tools/FileEditTool/ (the newer
 * Claude Code folds `replace_all` into Edit and exposes batched edits via
 * MultiEdit). Both paths share the same match/replace semantics, so we
 * centralize them here:
 *
 *   - smart-quote normalization on the model-supplied strings (the file
 *     content is searched as-is — normalizing the model's curly quotes is
 *     what lets a straight-quote file still match)
 *   - unique-match safety: without `replace_all`, more than one match is an
 *     error rather than a silent first-only replace
 *   - `replace_all`: replace every occurrence and report the count
 */

/** A single find/replace operation, shared by Edit (one) and MultiEdit (many). */
export interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Thrown when an edit can't be applied; message is surfaced to the model. */
export class EditError extends Error {}

export function normalizeQuotes(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const foundIndex = haystack.indexOf(needle, fromIndex);
    if (foundIndex === -1) return count;
    count += 1;
    fromIndex = foundIndex + needle.length;
  }
}

/**
 * Apply one edit to a string in memory. Pure function — callers handle file
 * IO and atomicity. Throws `EditError` with a model-facing message when the
 * edit can't be applied unambiguously.
 */
export function applyEditToContent(
  content: string,
  edit: SingleEdit,
): { content: string; replacements: number } {
  const oldString = normalizeQuotes(edit.old_string);
  const newString = normalizeQuotes(edit.new_string);

  if (!oldString) {
    throw new EditError("old_string must not be empty");
  }
  if (oldString === newString) {
    throw new EditError("old_string and new_string are identical — nothing to change");
  }

  const occurrences = countOccurrences(content, oldString);
  if (occurrences === 0) {
    throw new EditError(`old_string not found`);
  }
  if (!edit.replace_all && occurrences > 1) {
    throw new EditError(
      `old_string matched ${occurrences} times; set replace_all=true or add surrounding context for a unique match`,
    );
  }

  const updated = edit.replace_all
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  return { content: updated, replacements: edit.replace_all ? occurrences : 1 };
}

/**
 * Apply a sequence of edits to a string, one after another. Each edit sees
 * the result of the previous one (chained editing). All-or-nothing: a failure
 * throws `EditError` tagged with the failing edit's index, and the caller
 * must NOT write partial results to disk.
 */
export function applyEditsToContent(
  content: string,
  edits: SingleEdit[],
): { content: string; totalReplacements: number } {
  let current = content;
  let totalReplacements = 0;
  for (let i = 0; i < edits.length; i += 1) {
    try {
      const { content: next, replacements } = applyEditToContent(current, edits[i]);
      current = next;
      totalReplacements += replacements;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new EditError(`edit #${i + 1} failed: ${message}`);
    }
  }
  return { content: current, totalReplacements };
}

/** Build a small +/- preview of an edit for the tool result. */
export function buildEditPreview(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n").slice(0, 3);
  const newLines = newString.split("\n").slice(0, 3);
  return [
    "Preview:",
    ...oldLines.map((line) => `- ${line}`),
    ...newLines.map((line) => `+ ${line}`),
  ].join("\n");
}

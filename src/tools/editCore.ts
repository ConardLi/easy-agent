export function normalizeQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

export function applyEditToContent(content: string, edit: { old_string: string; new_string: string }): string {
  const normalizedOld = normalizeQuotes(edit.old_string);
  const normalizedContent = normalizeQuotes(content);

  const index = normalizedContent.indexOf(normalizedOld);
  if (index === -1) {
    throw new Error("Could not find the specified old_string in the content.");
  }

  const before = content.substring(0, index);
  const after = content.substring(index + edit.old_string.length);

  return before + edit.new_string + after;
}

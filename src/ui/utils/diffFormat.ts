/**
 * Line-level diff helpers for tool-result rendering.
 *
 * Edit calls hand us the `old_string` / `new_string` fragments directly, so a
 * line diff of those two fragments IS the change to show — no file-system read
 * and no absolute line numbers needed. `diffLines` gives us a list of parts
 * tagged added / removed / unchanged; we flatten that into one line array the
 * <StructuredDiff> component can render row by row.
 */
import { diffLines } from "diff";

export type DiffKind = "add" | "del" | "context";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** Flatten a two-string diff into per-line {kind,text} rows. */
export function computeDiffLines(oldText: string, newText: string): DiffLine[] {
  const parts = diffLines(oldText, newText);
  const out: DiffLine[] = [];
  for (const part of parts) {
    const kind: DiffKind = part.added ? "add" : part.removed ? "del" : "context";
    const lines = part.value.split("\n");
    // `diffLines` keeps the trailing newline, which yields a spurious empty
    // final element — drop it so we don't render a blank row per part.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) out.push({ kind, text });
  }
  return out;
}

/** Count added / removed lines for the compact `+N -N` header stat. */
export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of computeDiffLines(oldText, newText)) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

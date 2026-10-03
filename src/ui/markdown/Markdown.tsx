/**
 * Markdown rendering components.
 *
 *   <Markdown>          — for FINALIZED text (committed history). Converts
 *                         once and renders the ANSI string in a <Text>.
 *
 *   <StreamingMarkdown> — for the LIVE streaming line. Implements the
 *                         "stable prefix" anti-flicker strategy:
 *                           - completed blocks (everything before the last
 *                             paragraph break / closed code fence) are
 *                             rendered as Markdown and never re-formatted;
 *                           - the trailing, still-incomplete block is shown
 *                             as PLAIN text so a half-written **bold** or an
 *                             unterminated ```fence``` doesn't flicker
 *                             between styled and unstyled on every chunk.
 *                         When the tail completes it rolls into the stable
 *                         prefix and gets formatted — exactly once.
 */

import React from "react";
import { Text } from "ink";
import { markdownToAnsi } from "./markdownToAnsi.js";

interface MarkdownProps {
  content: string;
  /** Optional color for plain (non-Markdown) text; Markdown carries its own. */
  color?: string;
}

export const Markdown = React.memo(function Markdown({ content, color }: MarkdownProps): React.ReactNode {
  const rendered = React.useMemo(() => markdownToAnsi(content), [content]);
  return <Text color={color}>{rendered}</Text>;
});

/**
 * Split `content` into a finalized prefix and an in-progress tail.
 *
 * Boundary rules (checked in order):
 *   1. If an odd number of ``` fences is present, a code block is still
 *      open — the prefix ends right before that last fence, and the open
 *      fence (+ everything after) is the tail.
 *   2. Otherwise the prefix ends at the last paragraph break (`\n\n`).
 *   3. If neither exists, everything is tail (nothing stable yet).
 */
export function splitStablePrefix(content: string): { stable: string; tail: string } {
  const fenceCount = (content.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    const lastFence = content.lastIndexOf("```");
    return { stable: content.slice(0, lastFence), tail: content.slice(lastFence) };
  }
  const lastBreak = content.lastIndexOf("\n\n");
  if (lastBreak < 0) return { stable: "", tail: content };
  return { stable: content.slice(0, lastBreak), tail: content.slice(lastBreak + 2) };
}

interface StreamingMarkdownProps {
  content: string;
  color?: string;
}

export function StreamingMarkdown({ content, color }: StreamingMarkdownProps): React.ReactNode {
  const { stable, tail } = React.useMemo(() => splitStablePrefix(content), [content]);
  // The stable prefix is memoized through <Markdown> (+ the ANSI cache), so
  // it isn't re-lexed on every chunk; only the small plain tail repaints.
  return (
    <Text color={color}>
      {stable ? <Markdown content={stable} color={color} /> : null}
      {stable && tail ? "\n" : null}
      {tail ? <Text color={color}>{tail}</Text> : null}
    </Text>
  );
}

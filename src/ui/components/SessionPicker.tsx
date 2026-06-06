/**
 * SessionPicker — interactive overlay for `/resume`. Lists the project's saved
 * sessions; the user moves the cursor with ↑/↓ (or a 1-9 quick key) and presses
 * Enter to switch. Mirrors source's LogSelector (commands/resume): each row is
 * labelled by the session's first user prompt (not the opaque UUID), and only a
 * bounded window of rows is shown at once so a long history can't fill the
 * screen — the viewport scrolls to keep the cursor in view.
 *
 * Pure presentation: keyboard handling lives in hooks/useResumePicker, and the
 * actual switch is performed by re-invoking `/resume <id>` through the engine.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ResumeSessionInfo } from "../../core/queryEngine.js";
import { theme, glyph } from "../theme.js";

interface SessionPickerProps {
  sessions: ResumeSessionInfo[];
  /** Cursor position into `sessions`. */
  index: number;
}

/** How many rows to show at once before the viewport scrolls. */
const MAX_VISIBLE = 8;

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** A one-line label for a session: its first prompt, or a fallback. */
function label(session: ResumeSessionInfo): string {
  const prompt = session.firstPrompt.trim();
  if (!prompt) return "(empty session)";
  return prompt.length > 56 ? `${prompt.slice(0, 55)}…` : prompt;
}

/** Best-effort "x ago" from an ISO timestamp; falls back to the raw string. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Window of indices [start, start+MAX_VISIBLE) that keeps `index` visible. */
function computeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  let start = index - Math.floor(MAX_VISIBLE / 2);
  start = Math.max(0, Math.min(start, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

export function SessionPicker({ sessions, index }: SessionPickerProps): React.ReactNode {
  if (!sessions || sessions.length === 0) return null;

  const { start, end } = computeWindow(sessions.length, index);
  const above = start;
  const below = sessions.length - end;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Resume a session
        </Text>
        <Text color={theme.muted}>{`  ${sessions.length} total · ↑↓ navigate · 1-9 quick · Enter resume · Esc cancel`}</Text>
      </Box>

      {above > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↑ ${above} more`}</Text>
        </Box>
      ) : null}

      {sessions.slice(start, end).map((s, offset) => {
        const i = start + offset;
        const selected = i === index;
        const prefix = selected ? "\u25B6 " : "  ";
        const num = i < 9 ? `${i + 1}.` : "  ";
        const current = s.isCurrent ? "  (current)" : "";
        return (
          <Box key={s.sessionId} flexDirection="column">
            <Box>
              <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
                {prefix}
                {num} {label(s)}
              </Text>
              <Text color={theme.muted}>{current}</Text>
            </Box>
            <Box marginLeft={6}>
              <Text color={theme.muted} dimColor>
                {`${shortId(s.sessionId)} · ${relativeTime(s.updatedAt)} · ${s.messageCount} msg · ${s.model}`}
              </Text>
            </Box>
          </Box>
        );
      })}

      {below > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↓ ${below} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

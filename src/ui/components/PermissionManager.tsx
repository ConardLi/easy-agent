/**
 * PermissionManager — interactive overlay for `/permissions` (no args).
 *
 * Mirrors source's PermissionRuleList (components/permissions/rules): Allow / Deny
 * tabs, each listing the active rules plus an "Add a new rule…" entry; selecting
 * a rule confirms deletion, selecting "Add" prompts for a rule string. easy-agent
 * has no Ask tier / Workspace dirs / Recently-denied retry, so those tabs are
 * omitted (it has no underlying support for them).
 *
 * Self-contained: it renders AND owns its keyboard (useInput) and its transient
 * UI state (tab / cursor / add-or-delete mode / text buffer / scope). Persisted
 * mutations go through `onMutate`, which calls the engine directly and feeds back
 * fresh data; the in-memory "session" rules are shown read-only.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type {
  PermissionsViewData,
  PermissionRuleRow,
  PermissionRuleScope,
} from "../../core/queryEngine.js";
import type { SettingSource } from "../../config/sources.js";
import { theme, glyph } from "../theme.js";

interface PermissionManagerProps {
  data: PermissionsViewData;
  /** Whether this overlay currently owns the keyboard. */
  active: boolean;
  /** Apply a persisted rule change (engine write + reload), then refresh. */
  onMutate: (op: "allow" | "deny" | "remove", rule: string, scope: SettingSource) => void;
  /** Dismiss the overlay. */
  onClose: () => void;
}

type Tab = "allow" | "deny";
type Mode = "list" | "adding" | "confirmDelete";

const ADD_ROW = "\u2295 Add a new rule\u2026";
const WRITABLE_SCOPES: SettingSource[] = ["user", "project", "local"];
const MAX_VISIBLE = 8;

function scopeBadge(scope: PermissionRuleScope): string {
  switch (scope) {
    case "user":
      return "user";
    case "project":
      return "project";
    case "local":
      return "local";
    case "session":
      return "session";
    default:
      return String(scope);
  }
}

function computeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  let start = index - Math.floor(MAX_VISIBLE / 2);
  start = Math.max(0, Math.min(start, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

export function PermissionManager({
  data,
  active,
  onMutate,
  onClose,
}: PermissionManagerProps): React.ReactNode {
  const [tab, setTab] = React.useState<Tab>("allow");
  const [index, setIndex] = React.useState(0);
  const [mode, setMode] = React.useState<Mode>("list");
  const [buffer, setBuffer] = React.useState("");
  const [addScope, setAddScope] = React.useState<SettingSource>("local");

  const rows: PermissionRuleRow[] = tab === "allow" ? data.allow : data.deny;
  // Row 0 is the "Add a new rule…" entry; rows[1..] are the rule entries.
  const total = rows.length + 1;
  const clampedIndex = Math.min(index, total - 1);

  useInput(
    (input, key) => {
      if (!active) return;
      if (key.ctrl || key.meta) return;

      if (mode === "adding") {
        if (key.escape) {
          setMode("list");
          setBuffer("");
          return;
        }
        if (key.return) {
          const rule = buffer.trim();
          if (rule) {
            onMutate(tab, rule, addScope);
            setMode("list");
            setBuffer("");
            setIndex(0);
          }
          return;
        }
        if (key.tab) {
          // Cycle the destination layer for the new rule.
          const i = WRITABLE_SCOPES.indexOf(addScope);
          setAddScope(WRITABLE_SCOPES[(i + 1) % WRITABLE_SCOPES.length]!);
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        if (input && !key.return) setBuffer((b) => b + input);
        return;
      }

      if (mode === "confirmDelete") {
        const row = rows[clampedIndex - 1];
        if ((input === "y" || input === "Y") && row && row.scope !== "session") {
          onMutate("remove", row.rule, row.scope as SettingSource);
          setMode("list");
          setIndex((i) => Math.max(0, Math.min(i, rows.length)));
          return;
        }
        if (input === "n" || input === "N" || key.escape) {
          setMode("list");
          return;
        }
        return;
      }

      // mode === "list"
      if (key.escape) {
        onClose();
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setTab((t) => (t === "allow" ? "deny" : "allow"));
        setIndex(0);
        return;
      }
      if (key.upArrow) {
        setIndex((i) => (i - 1 + total) % total);
        return;
      }
      if (key.downArrow) {
        setIndex((i) => (i + 1) % total);
        return;
      }
      if (key.return) {
        if (clampedIndex === 0) {
          setMode("adding");
          setBuffer("");
          return;
        }
        const row = rows[clampedIndex - 1];
        if (row && row.scope !== "session") setMode("confirmDelete");
        return;
      }
    },
    { isActive: active },
  );

  const otherTab: Tab = tab === "allow" ? "deny" : "allow";
  const otherCount = (tab === "allow" ? data.deny : data.allow).length;

  // ── adding: text input row ──
  if (mode === "adding") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.info}>{glyph.toolDot} </Text>
          <Text color={theme.info} bold>{`Add ${tab} rule`}</Text>
          <Text color={theme.muted}>{`  → ${addScope} settings · Tab change scope · Enter save · Esc cancel`}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text>{"rule: "}</Text>
          <Text color={theme.brand}>{buffer}</Text>
          <Text color={theme.brand}>{"\u2588"}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>
            {"Examples: Read · Bash(git status:*) · WebFetch(domain:example.com)"}
          </Text>
        </Box>
      </Box>
    );
  }

  // ── list (and confirmDelete overlay on the selected row) ──
  const { start, end } = computeWindow(total, clampedIndex);
  const above = start;
  const below = total - end;

  // Build the renderable row set: index 0 = ADD_ROW, then rules.
  const renderRows: { key: string; isAdd: boolean; row?: PermissionRuleRow }[] = [
    { key: "__add__", isAdd: true },
    ...rows.map((r, i) => ({ key: `${r.scope}:${r.rule}:${i}`, isAdd: false, row: r })),
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Permissions
        </Text>
        <Text color={theme.muted}>{`  mode: ${data.mode}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={tab === "allow" ? theme.brand : theme.muted} bold={tab === "allow"}>
          {`[Allow ${data.allow.length}]`}
        </Text>
        <Text color={theme.muted}>{"  "}</Text>
        <Text color={tab === "deny" ? theme.brand : theme.muted} bold={tab === "deny"}>
          {`[Deny ${data.deny.length}]`}
        </Text>
        <Text color={theme.muted}>{`   ←/→ switch to ${otherTab} (${otherCount})`}</Text>
      </Box>

      {above > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↑ ${above} more`}</Text>
        </Box>
      ) : null}

      {renderRows.slice(start, end).map((entry, offset) => {
        const i = start + offset;
        const selected = i === clampedIndex;
        const prefix = selected ? "\u25B6 " : "  ";
        if (entry.isAdd) {
          return (
            <Box key={entry.key}>
              <Text color={selected ? theme.brand : theme.muted} bold={selected}>
                {prefix}
                {ADD_ROW}
              </Text>
            </Box>
          );
        }
        const row = entry.row!;
        const isSession = row.scope === "session";
        const confirming = selected && mode === "confirmDelete";
        return (
          <Box key={entry.key}>
            <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
              {prefix}
              {row.rule}
            </Text>
            <Text color={theme.muted} dimColor>{`  [${scopeBadge(row.scope)}]`}</Text>
            {confirming ? (
              <Text color={theme.error}>{"  delete? y/n"}</Text>
            ) : isSession ? (
              <Text color={theme.muted} dimColor>{"  (not editable)"}</Text>
            ) : null}
          </Box>
        );
      })}

      {below > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`↓ ${below} more`}</Text>
        </Box>
      ) : null}

      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.muted} dimColor>
          {mode === "confirmDelete"
            ? "y delete · n cancel"
            : "↑↓ navigate · Enter add/delete · ←/→ switch tab · Esc close"}
        </Text>
      </Box>
    </Box>
  );
}

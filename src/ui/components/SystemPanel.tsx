import type React from "react";
import { Box, Text } from "ink";
import { theme, glyph } from "../theme.js";
import type { SystemNotice } from "../types.js";

interface SystemPanelProps {
  notice: SystemNotice | null;
}

// A listing row: "<name> — <description>". The name is colored + aligned into
// a column; the description trails in muted text.
const ITEM_RE = /^(\s*)(\S.*?)\s+\u2014\s+(.*)$/;

interface ParsedLine {
  kind: "item" | "detail" | "text" | "blank";
  indent: string;
  name?: string;
  desc?: string;
  text?: string;
}

function parseLine(line: string): ParsedLine {
  if (line.trim() === "") return { kind: "blank", indent: "" };
  const m = ITEM_RE.exec(line);
  if (m) {
    return { kind: "item", indent: m[1] ?? "", name: m[2] ?? "", desc: m[3] ?? "" };
  }
  // Indented continuation (≥3 spaces) with no " — " → metadata / file path.
  if (/^\s{3,}\S/.test(line)) {
    return { kind: "detail", indent: "", text: line.trimStart() };
  }
  return { kind: "text", indent: "", text: line };
}

export function SystemPanel({ notice }: SystemPanelProps): React.ReactNode {
  if (!notice) {
    return null;
  }

  const color = notice.tone === "error" ? theme.error : theme.info;
  const parsed = notice.body ? notice.body.split("\n").map(parseLine) : [];

  // Width of the fixed name column (indent + name), capped so a very long name
  // can't starve the description column. Descriptions live in a flex column to
  // the right and wrap with a hanging indent — the name never breaks.
  const nameCol = Math.min(
    24,
    Math.max(
      0,
      ...parsed
        .filter((p) => p.kind === "item")
        .map((p) => (p.indent ?? "").length + (p.name ?? "").length),
    ),
  );
  const leftWidth = 2 + nameCol + 2; // base indent + name + gap

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={color}>{glyph.toolDot} </Text>
        <Text color={color} bold>
          {notice.title}
        </Text>
      </Box>
      {parsed.map((p, index) => {
        if (p.kind === "blank") {
          return <Box key={index} height={1} />;
        }
        if (p.kind === "item") {
          return (
            <Box key={index}>
              <Box width={leftWidth} flexShrink={0}>
                <Text color={theme.brand} bold wrap="truncate-end">
                  {"  "}
                  {p.indent}
                  {p.name}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={theme.muted}>{p.desc}</Text>
              </Box>
            </Box>
          );
        }
        if (p.kind === "detail") {
          return (
            <Box key={index} marginLeft={6}>
              <Text color={theme.muted} dimColor>
                {p.text}
              </Text>
            </Box>
          );
        }
        return (
          <Box key={index} marginLeft={2}>
            <Text color={theme.muted}>{p.text}</Text>
          </Box>
        );
      })}
      {notice.dismissable ? (
        <Box marginTop={parsed.length > 0 ? 1 : 0} marginLeft={2}>
          <Text color={theme.muted} dimColor>
            {"esc to dismiss"}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

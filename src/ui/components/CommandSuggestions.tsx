import type React from "react";
import { Box, Text, useStdout } from "ink";
import { theme, glyph } from "../theme.js";
import type { CommandSuggestion } from "../types.js";

interface CommandSuggestionsProps {
  items: CommandSuggestion[];
}

// How many rows are visible at once; the list scrolls (centered on the
// selection) when there are more, instead of flooding the terminal.
const MAX_VISIBLE = 8;

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + "\u2026";
}

export function CommandSuggestions({ items }: CommandSuggestionsProps): React.ReactNode {
  const { stdout } = useStdout();
  if (items.length === 0) {
    return null;
  }

  const columns = stdout?.columns ?? 80;
  const selected = Math.max(0, items.findIndex((i) => i.isSelected));

  // Window the list, keeping the selection roughly centered.
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE),
  );
  const end = Math.min(start + MAX_VISIBLE, items.length);
  const visible = items.slice(start, end);

  // Fixed name column so descriptions line up; capped at 40% of the width.
  const nameWidth = Math.min(
    Math.max(...items.map((i) => i.name.length)),
    Math.floor(columns * 0.4),
  );

  return (
    <Box marginTop={1} flexDirection="column" paddingX={1}>
      {visible.map((item) => {
        const isSelected = Boolean(item.isSelected);
        const name = truncate(item.name, nameWidth);
        const paddedName = name + " ".repeat(Math.max(0, nameWidth - name.length));
        const tagText = item.tag ? `[${item.tag}] ` : "";
        const tagColor = item.tag === "local" ? theme.warn : theme.info;
        const descWidth = Math.max(0, columns - nameWidth - tagText.length - 6);
        const desc = truncate(item.description.replace(/\s+/g, " "), descWidth);
        return (
          <Text key={item.name} wrap="truncate">
            <Text color={isSelected ? theme.brand : theme.muted} bold={isSelected}>
              {isSelected ? `${glyph.promptCaret} ` : "  "}
            </Text>
            <Text color={isSelected ? theme.brandLight : undefined} dimColor={!isSelected} bold={isSelected}>
              {paddedName}
            </Text>
            {tagText ? (
              <Text color={tagColor} dimColor={!isSelected}>
                {tagText}
              </Text>
            ) : null}
            <Text color={isSelected ? undefined : theme.muted} dimColor={!isSelected}>
              {"  "}
              {desc}
            </Text>
          </Text>
        );
      })}
      <Text color={theme.muted} dimColor>
        {`↑↓ navigate · ↵ run · ⇥ complete${items.length > MAX_VISIBLE ? `   ${selected + 1}/${items.length}` : ""}`}
      </Text>
    </Box>
  );
}

/**
 * Visual smoke for the upgraded /command palette + post-command panel.
 * Run: ./node_modules/.bin/tsx src/scripts/smoke-command.tsx
 */
import type React from "react";
import { Box, Text, render } from "ink";
import { CommandSuggestions } from "../ui/components/CommandSuggestions.js";
import { SystemPanel } from "../ui/components/SystemPanel.js";
import type { CommandSuggestion } from "../ui/types.js";

const items: CommandSuggestion[] = [
  { name: "/clear", description: "Clear conversation history", isSelected: true },
  { name: "/compact", description: "Compact the conversation context" },
  { name: "/cost", description: "Show session token usage" },
  { name: "/model", description: "Inspect current model or override it for this session" },
  { name: "/mode", description: "Inspect or switch permission mode (default/plan/auto)" },
  { name: "/review", description: "Review recent changes for bugs and style", tag: "local" },
  { name: "/de-ai-rewriter", description: "Rewrite Chinese text to sound natural", tag: "skill" },
  { name: "/tasks", description: "Switch task tracking system (task/todo)" },
  { name: "/skills", description: "List loaded skills (user + project scope)" },
  { name: "/agents", description: "List built-in + custom sub-agent definitions" },
];

function App(): React.ReactNode {
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text dimColor>— /command palette (first item auto-selected, windowed) —</Text>
      <CommandSuggestions items={items} />

      <Box marginTop={1}>
        <Text dimColor>— post-command panel (/help) —</Text>
      </Box>
      <SystemPanel
        notice={{
          tone: "info",
          title: "Available commands",
          dismissable: true,
          body: [
            "/help — Show available commands",
            "/clear — Clear conversation history",
            "/cost — Show session token usage",
            "/model [name|default] — Inspect or override the session model",
          ].join("\n"),
        }}
      />

      <Box marginTop={1}>
        <Text dimColor>— /skills listing —</Text>
      </Box>
      <SystemPanel
        notice={{
          tone: "info",
          title: "Skills (3 loaded)",
          dismissable: true,
          body: [
            "  /commit — Create a git commit with a generated message",
            "    user · allowed-tools: Bash",
            "  /de-ai-rewriter — Rewrite Chinese text to sound natural and human",
            "    project · conditional: *.md",
            "  /review — Review recent changes for bugs and style issues",
            "    user",
            "",
            "Invoke a skill with /<name> [args], or let the model call it via the Skill tool.",
          ].join("\n"),
        }}
      />

      <Box marginTop={1}>
        <Text dimColor>— /agents listing —</Text>
      </Box>
      <SystemPanel
        notice={{
          tone: "info",
          title: "Agents (2 loaded)",
          dismissable: true,
          body: [
            "  code-reviewer — Use after code changes to review for bugs and style",
            "    built-in · tools: * · model: default",
            "  explore — Fast read-only codebase exploration agent",
            "    built-in · tools: Read,Grep,Glob",
            "",
            "Sub-agents are spawned by the model via the `Agent` tool.",
          ].join("\n"),
        }}
      />

      <Box marginTop={1}>
        <Text dimColor>— error panel —</Text>
      </Box>
      <SystemPanel notice={{ tone: "error", title: "Invalid mode: foo", body: "Must be default, plan, or auto." }} />
    </Box>
  );
}

const { unmount } = render(<App />);
setTimeout(() => unmount(), 100);

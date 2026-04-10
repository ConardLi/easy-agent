/**
 * Step 7 - Permission model (allow / ask / deny)
 *
 * Goal:
 * - classify tool calls before execution
 * - auto-allow low-risk reads
 * - ask for writes
 * - deny obviously dangerous operations
 */

const READ_ONLY_SHELL_PREFIXES = [
  "pwd",
  "ls",
  "cat",
  "find",
  "rg",
  "grep",
  "git status",
  "git diff",
  "git log",
];

const DANGEROUS_BASH_PREFIXES = [
  "rm ",
  "sudo ",
  "git push",
  "git reset --hard",
  "shutdown",
  "reboot",
];

export function isReadOnlyCommand(command = "") {
  const normalized = command.trim().replace(/\s+/g, " ");
  return READ_ONLY_SHELL_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

export function isDangerousCommand(command = "") {
  const normalized = command.trim().replace(/\s+/g, " ").toLowerCase();
  return DANGEROUS_BASH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function summarizePermissionRequest(toolName, input) {
  if (toolName === "Bash") {
    return `command=${input.command || "<empty>"}`;
  }

  return Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

export async function checkPermission({ tool, input, mode = "default" }) {
  const request = {
    toolName: tool.name,
    input,
    summary: summarizePermissionRequest(tool.name, input),
  };

  if (mode === "auto") {
    return { behavior: "allow", reason: "auto mode", request };
  }

  if (mode === "plan" && !tool.isReadOnly()) {
    return { behavior: "deny", reason: "plan mode blocks write actions", request };
  }

  if (tool.name === "Bash") {
    if (isDangerousCommand(input.command)) {
      return { behavior: "deny", reason: "dangerous shell command", request };
    }

    if (isReadOnlyCommand(input.command)) {
      return { behavior: "allow", reason: "read-only shell command", request };
    }

    return { behavior: "ask", reason: "shell command may change local state", request };
  }

  if (tool.isReadOnly()) {
    return { behavior: "allow", reason: "read-only tool", request };
  }

  return { behavior: "ask", reason: "tool writes local state", request };
}

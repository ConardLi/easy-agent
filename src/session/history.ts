import { listProjectSessions, type SessionSummary } from "./storage.js";

function formatSessionUsage(summary: SessionSummary): string {
  const total = summary.totalUsage.input_tokens + summary.totalUsage.output_tokens;
  return `${summary.totalUsage.input_tokens} in / ${summary.totalUsage.output_tokens} out / ${total} total`;
}

export async function formatProjectSessionHistory(cwd: string): Promise<string> {
  const sessions = await listProjectSessions(cwd);
  if (sessions.length === 0) {
    return "No saved sessions found for this project.";
  }

  const lines = ["Recent sessions:"];
  for (const session of sessions) {
    lines.push(
      [
        `- ${session.sessionId}`,
        `  Updated: ${session.updatedAt}`,
        `  Started: ${session.startedAt}`,
        `  Messages: ${session.messageCount}`,
        `  Usage: ${formatSessionUsage(session)}`,
        `  Model: ${session.model}`,
      ].join("\n"),
    );
  }

  return lines.join("\n");
}

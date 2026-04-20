export function debugLog(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!process.env.EASY_AGENT_DEBUG) return;
  const timestamp = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[easy-agent][${timestamp}][${scope}] ${message}${suffix}`);
}

/**
 * Always-on warning to stderr. Used for non-fatal startup issues like a
 * malformed MCP server config — we want the user to see it even without
 * EASY_AGENT_DEBUG=1, but it must NOT corrupt Ink's stdout-rendered UI.
 */
export function logWarn(message: string): void {
  console.error(`[easy-agent][warn] ${message}`);
}

export function debugLog(scope: string, message: string, details?: Record<string, unknown>): void {
  if (!process.env.EASY_AGENT_DEBUG) return;
  const timestamp = new Date().toISOString();
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console.error(`[easy-agent][${timestamp}][${scope}] ${message}${suffix}`);
}

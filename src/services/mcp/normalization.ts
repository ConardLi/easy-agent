/**
 * Pure utility for MCP name normalization.
 *
 * Reference: claude-code-source-code/src/services/mcp/normalization.ts
 *
 * The Anthropic API requires tool names to match `^[a-zA-Z0-9_-]{1,64}$`.
 * MCP server/tool names allow much more (dots, spaces, etc.), so we replace
 * any invalid character with `_` before stitching them into the
 * `mcp__<server>__<tool>` envelope.
 */

export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

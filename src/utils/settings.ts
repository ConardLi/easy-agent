/**
 * Safe JSON config-file reader, shared by every loader that consumes a
 * settings.json (currently: MCP servers + permission rules).
 *
 * What "safe" means here:
 *   - File missing  → returns { raw: null } silently. settings.json is
 *     optional; users without one should still get a working CLI.
 *   - Invalid JSON  → returns { raw: null, parseError: "..." } so the
 *     caller can decide whether to log a warning, abort startup, or
 *     fall back to defaults. The raw JSON parse error message is
 *     included verbatim so the user can find the offending line.
 *   - Other I/O err → returns { raw: null, parseError: "..." } likewise,
 *     prefixed with "Failed to read".
 *
 * What this DOES NOT do:
 *   - Schema validation. Every consumer (MCP / permissions / future
 *     settings) has its own schema and merge semantics, and they should
 *     own that logic. This util is just the file-reading primitive.
 *   - Caching. Settings change rarely and the file is small; the loaders
 *     above this layer can cache if they want.
 *   - Merging across scopes. The user/project merge logic lives in the
 *     caller because the rules differ per feature (MCP overrides per
 *     server name, permissions concatenate arrays, etc.).
 *
 * Reference: this consolidates the two near-identical
 * `readSettingsFile()` helpers that lived in `services/mcp/config.ts`
 * and `permissions/permissions.ts`.
 */

import * as fs from "node:fs/promises";

export interface SettingsFileResult<T = unknown> {
  /** Parsed JSON object, or null if missing / unreadable / invalid. */
  raw: T | null;
  /** Human-readable error if the file existed but couldn't be parsed. */
  parseError?: string;
}

/**
 * Read and JSON-parse a settings file. Never throws — the caller decides
 * how to surface failures (log a warning, fall back to defaults, etc.).
 *
 * @param filePath Absolute path to the settings file. Use the path
 *   helpers in `./paths.ts` to construct this; do NOT inline-build it.
 */
export async function readJsonSettingsFile<T = unknown>(
  filePath: string,
): Promise<SettingsFileResult<T>> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { raw: null };
    return {
      raw: null,
      parseError: `Failed to read ${filePath}: ${(error as Error).message}`,
    };
  }

  try {
    const parsed = JSON.parse(text) as T;
    return { raw: parsed };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return {
        raw: null,
        parseError: `Invalid JSON in ${filePath}: ${error.message}`,
      };
    }
    return {
      raw: null,
      parseError: `Failed to parse ${filePath}: ${(error as Error).message}`,
    };
  }
}

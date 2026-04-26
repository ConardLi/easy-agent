/**
 * YAML frontmatter parser for SKILL.md files.
 *
 * Splits a `---\n...\n---\n<body>` document into its frontmatter object
 * (parsed with the `yaml` package) and the markdown body. Returns the body
 * unchanged when no frontmatter delimiters are present.
 *
 * Reference: claude-code-source-code/src/utils/frontmatterParser.ts (full
 * implementation has shell hooks + path splitting; we keep just the
 * structural split here and do field-by-field normalization in
 * loadSkillsDir.ts).
 */

import { parse as parseYaml } from "yaml";
import type { SkillFrontmatter } from "../../types/types.js";

export interface FrontmatterSplit {
  /** Raw frontmatter object (any YAML scalar / map / list). Empty object when absent. */
  raw: Record<string, unknown>;
  /** Markdown content with the frontmatter block stripped. */
  body: string;
  /** Set when YAML parsing failed; caller should warn + fall back to {}. */
  parseError?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split + parse a SKILL.md document.
 *
 * - Returns `{ raw: {}, body: <whole input> }` when no frontmatter is found.
 * - Never throws — invalid YAML is reported via `parseError` so the loader
 *   can log a warning and skip the skill rather than crashing startup.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { raw: {}, body: content };
  }

  const [, yamlText, body] = match;
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { raw: parsed as Record<string, unknown>, body };
    }
    // Frontmatter that isn't an object (e.g. `---\nfoo\n---`) is a config
    // bug, not a usable skill. Treat as parse failure so the user notices.
    return { raw: {}, body, parseError: "Frontmatter must be a YAML mapping (key: value)" };
  } catch (error: unknown) {
    return {
      raw: {},
      body,
      parseError: (error as Error).message,
    };
  }
}

// ─── Field normalization ──────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : undefined))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    // CSV-style: "Read, Grep, Glob" or single value
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "yes" || v === "1";
  }
  return false;
}

/**
 * Extract the first non-empty paragraph from a markdown body. Used as a
 * fallback when the SKILL.md frontmatter has no `description`. Strips
 * leading H1/H2 headings so we don't show "# Code Review" as the desc.
 */
export function extractFallbackDescription(body: string): string {
  const lines = body.split(/\r?\n/);
  const buf: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (buf.length > 0) break;
      continue;
    }
    // Skip leading headings — they're redundant with the skill name.
    if (buf.length === 0 && line.startsWith("#")) continue;
    buf.push(line);
  }
  return buf.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Normalize a raw YAML map into a `SkillFrontmatter`. Caller passes the
 * skill name (= dir name) so we can default-populate the `name` field, and
 * the markdown body so we can derive a fallback description.
 *
 * Unknown / deferred fields (model, effort, hooks, agent, shell, …) are
 * preserved untouched in `frontmatter.raw` so future stages can read them
 * without re-parsing the file.
 */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
  body: string,
): SkillFrontmatter {
  const allowedTools = asStringArray(raw["allowed-tools"] ?? raw["allowedTools"]);
  const paths = asStringArray(raw["paths"]);
  return {
    name: asString(raw["name"]),
    description: asString(raw["description"]),
    when_to_use: asString(raw["when_to_use"] ?? raw["whenToUse"]),
    allowedTools,
    argumentHint: asString(raw["argument-hint"] ?? raw["argumentHint"]),
    disableModelInvocation: asBoolean(
      raw["disable-model-invocation"] ?? raw["disableModelInvocation"],
    ),
    paths: paths.length > 0 ? paths : undefined,
    hasForkContext: asString(raw["context"]) === "fork",
    raw,
  };
}

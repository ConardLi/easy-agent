/**
 * Field-level schema validation for a single settings source.
 *
 * Philosophy (matches how source treats settings.json):
 *   - Validation is *best-effort and additive*, never a gate. A settings file
 *     with one bad field must NOT take the whole file down — we keep every
 *     field we can parse and drop only the ones we can't.
 *   - Unknown keys are PRESERVED (`z.looseObject`). New settings keys that this
 *     build doesn't know about yet (or feature-specific keys owned by a loader,
 *     e.g. `sandbox`) flow through untouched.
 *   - Permission rule arrays (`allow`/`deny`/`ask`) get *per-rule* tolerance:
 *     a single malformed entry is dropped while the valid rules survive.
 *
 * Diagnostics: every repair (dropped rule, ignored field) is recorded as a
 * human-readable string so the CLI can surface a non-fatal notice telling the
 * user exactly which file/field was ignored.
 *
 * The key fields (model / permissions / hooks / env / mcpServers) are
 * validated with Zod and `.passthrough()`-style leniency; the schema does not
 * try to describe every possible key.
 */

import { z } from "zod";
import { ModelProfileSchema, ReasoningSchema, profileValidationErrors } from "./modelSchema.js";

const PermissionRule = z.string().trim().min(1);

/**
 * Schema for the *known* top-level settings fields. `looseObject` keeps any
 * other keys verbatim (passthrough), so this validates the fields we care
 * about without rejecting unknown ones.
 */
export const SettingsSchema = z.looseObject({
  model: z.string().trim().min(1).optional(),
  models: z.record(z.string(), ModelProfileSchema).optional(),
  reasoning: ReasoningSchema.optional(),
  // Role names match runtime invocation classes. Unknown roles are rejected.
  modelRoles: z
    .object({
      background: z.string().trim().min(1).optional(),
      think: z.string().trim().min(1).optional(),
      longContext: z.string().trim().min(1).optional(),
      compaction: z.string().trim().min(1).optional(),
      webFetch: z.string().trim().min(1).optional(),
    })
    .strict()
    .optional(),
  toolSearch: z.enum(["off", "auto", "on"]).optional(),
  toolSearchAutoThreshold: z.number().min(0).max(100).optional(),
  mode: z.enum(["default", "plan", "auto"]).optional(),
  // Convenience switch equivalent to `mode: "auto"`. Like `mode`,
  // it is SECURITY-SENSITIVE and only honored from trusted scopes (user / flag
  // / policy) — never from a checked-in project/local settings file.
  autoMode: z.boolean().optional(),
  allow: z.array(PermissionRule).optional(),
  deny: z.array(PermissionRule).optional(),
  ask: z.array(PermissionRule).optional(),
  additionalDirectories: z.array(PermissionRule).optional(),
  env: z.record(z.string(), z.coerce.string()).optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  statusLine: z.union([z.string(), z.looseObject({})]).optional(),
  outputStyle: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  cleanupPeriodDays: z.number().int().nonnegative().optional(),
  // Tool-turn limit for one request of the main session. Sub-agents keep
  // their own `maxTurns` frontmatter.
  maxTurns: z.number().int().positive().optional(),
  // Tier 2
  disableAllHooks: z.boolean().optional(),
  // Master switch for file-history checkpointing (default on).
  checkpointingEnabled: z.boolean().optional(),
  respectGitignore: z.boolean().optional(),
  syntaxHighlightingDisabled: z.boolean().optional(),
  prefersReducedMotion: z.boolean().optional(),
  agentMdExcludes: z.array(PermissionRule).optional(),
  enableAllProjectMcpServers: z.boolean().optional(),
  enabledMcpjsonServers: z.array(PermissionRule).optional(),
  disabledMcpjsonServers: z.array(PermissionRule).optional(),
  // Per-scope plugin enable map. Keys are stable plugin ids
  // (`name@marketplace`); a `true` enables, `false` explicitly disables in
  // this scope (later scope wins). Install lives globally in
  // ~/.easy-agent/plugins; only ENABLE is scoped here.
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  // User-defined Agents: name → Harness spec. Read only from the user
  // settings file; each spec is validated when it is resolved (src/harness/).
  harnesses: z.record(z.string(), z.unknown()).optional(),
  // The project's default Agent: a name from `harnesses`. Read only from the
  // local settings file of a trusted workspace (src/harness/resolve.ts).
  harness: z.string().trim().min(1).optional(),
});

const RULE_ARRAY_KEYS = ["allow", "deny", "ask"] as const;

export interface ValidationResult {
  /** Cleaned settings object — valid known fields + all unknown fields. */
  value: Record<string, unknown>;
  /** One human-readable message per repair performed (dropped rule / field). */
  errors: string[];
}

/**
 * Validate + repair a single settings object.
 *
 * @param raw   The parsed JSON object for one source (already JSON-valid).
 * @param label A short source label for diagnostics (file path or "flag").
 */
export function validateSettings(
  raw: unknown,
  label: string,
  options: { partialProfiles?: boolean } = {},
): ValidationResult {
  if (raw == null) return { value: {}, errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: {}, errors: [`${label}: settings root must be a JSON object — ignored`] };
  }

  const errors: string[] = [];
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!Object.hasOwn(SettingsSchema.shape, key) && key !== "sandbox") {
      errors.push(`${label}: unsupported setting "${key}"; retained for compatibility but not applied by this build`);
    }
  }
  const candidate: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  // A malformed profile must remain diagnosable and must never disappear into
  // default selection. Validate it here, then preserve the map for the resolver.
  const models = candidate.models;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const [id, profile] of Object.entries(models)) {
      // Layer fragments are checked after merging. New writes still validate
      // complete profiles, and malformed selected profiles remain visible.
      if (!options.partialProfiles) errors.push(...profileValidationErrors(profile, `${label}.models.${id}`));
    }
    delete candidate.models;
  }
  const resultValue = (value: Record<string, unknown>): Record<string, unknown> =>
    models && typeof models === "object" && !Array.isArray(models) ? { ...value, models } : value;

  // 1) Per-rule tolerance for permission arrays: keep valid string rules,
  //    drop malformed entries (non-string / empty) without discarding the rest.
  for (const key of RULE_ARRAY_KEYS) {
    const value = candidate[key];
    if (!Array.isArray(value)) continue;
    const valid = value.filter((r) => typeof r === "string" && r.trim().length > 0);
    if (valid.length !== value.length) {
      errors.push(`${label}: dropped ${value.length - valid.length} invalid rule(s) in "${key}"`);
    }
    candidate[key] = valid.map((r) => (r as string).trim());
  }

  // 2) Zod parse. On failure, drop the offending top-level fields (identified
  //    by the first path segment of each issue) and retry — this yields
  //    field-level degradation instead of all-or-nothing rejection.
  let current = candidate;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = SettingsSchema.safeParse(current);
    if (result.success) return { value: resultValue(result.data as Record<string, unknown>), errors };

    const badKeys = new Set<string>();
    for (const issue of result.error.issues) {
      const top = issue.path[0];
      if (typeof top === "string") badKeys.add(top);
    }
    if (badKeys.size === 0) break;

    const next = { ...current };
    for (const key of badKeys) {
      delete next[key];
      errors.push(`${label}: ignored invalid field "${key}"`);
    }
    current = next;
  }

  // Fallback: hand back the best-effort object we have.
  return { value: resultValue(current), errors };
}

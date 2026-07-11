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
 * Reference: source validates the key fields (model / permissions / hooks /
 * env / mcpServers) with Zod and `.passthrough()`-style leniency; we mirror the
 * intent without copying its full schema surface.
 */

import { z } from "zod";

const PermissionRule = z.string().trim().min(1);

/**
 * Schema for the *known* top-level settings fields. `looseObject` keeps any
 * other keys verbatim (passthrough), so this validates the fields we care
 * about without rejecting unknown ones.
 */
export const SettingsSchema = z.looseObject({
  model: z.string().trim().min(1).optional(),
  // Stage 30: multi-protocol model profiles. Each entry declares a provider
  // target (protocol + model + endpoint + credentials). The map key is the
  // user-facing handle used by `--model` / `/model`. Validated leniently
  // (looseObject) so a single bad profile doesn't drop the whole `models` block;
  // deeper per-profile validation + ${ENV} interpolation lives in profile.ts.
  models: z
    .record(
      z.string(),
      z.looseObject({
        protocol: z.string().optional(),
        model: z.string().optional(),
        baseURL: z.string().optional(),
        apiKey: z.string().optional(),
        maxTokens: z.number().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  // Stage 30: default profile id (or raw model name) when no --model is given.
  defaultModel: z.string().trim().min(1).optional(),
  // Stage 30 (optional): map well-known roles → profile ids for future
  // task-based routing (background/think/longContext). Parsed but not yet wired.
  modelRoles: z.record(z.string(), z.string()).optional(),
  mode: z.enum(["default", "plan", "auto"]).optional(),
  // Stage 29: convenience switch equivalent to `mode: "auto"`. Like `mode`,
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
  apiKeyHelper: z.string().trim().min(1).optional(),
  cleanupPeriodDays: z.number().int().nonnegative().optional(),
  // Tier 2
  disableAllHooks: z.boolean().optional(),
  // Stage 26: master switch for file-history checkpointing (default on).
  checkpointingEnabled: z.boolean().optional(),
  // Stage 34: extended-thinking default switch. When false, thinking is
  // off by default (the `/think on` command can still enable it per-session).
  // When unset/true, thinking defaults to adaptive. Env var
  // MAX_THINKING_TOKENS overrides this (0 → disabled, N>0 → budget N).
  alwaysThinkingEnabled: z.boolean().optional(),
  // Stage 34: default reasoning-effort level for output_config.effort
  // (Anthropic only). The `/effort` command overrides this per-session.
  effortLevel: z.enum(["low", "medium", "high", "max"]).optional(),
  respectGitignore: z.boolean().optional(),
  syntaxHighlightingDisabled: z.boolean().optional(),
  prefersReducedMotion: z.boolean().optional(),
  claudeMdExcludes: z.array(PermissionRule).optional(),
  enableAllProjectMcpServers: z.boolean().optional(),
  enabledMcpjsonServers: z.array(PermissionRule).optional(),
  disabledMcpjsonServers: z.array(PermissionRule).optional(),
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
export function validateSettings(raw: unknown, label: string): ValidationResult {
  if (raw == null) return { value: {}, errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: {}, errors: [`${label}: settings root must be a JSON object — ignored`] };
  }

  const errors: string[] = [];
  const candidate: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

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
    if (result.success) return { value: result.data as Record<string, unknown>, errors };

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
  return { value: current, errors };
}

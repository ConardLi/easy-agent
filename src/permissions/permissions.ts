import * as path from "node:path";
import type { Tool } from "../tools/Tool.js";
import { isReadOnlyCommand } from "../tools/bashTool.js";
import { getPlanFilePath } from "../context/plans.js";
import { loadSettingSources, isTrustedScopeForSensitiveKeys } from "../config/sources.js";
import {
  loadSandboxSettings,
  shouldUseSandbox,
  splitCommand,
} from "../sandbox/index.js";

export type PermissionBehavior = "allow" | "ask" | "deny";
export type PermissionMode = "default" | "plan" | "auto";
export type PermissionDecision = "allow_once" | "allow_always" | "deny" | "allow_clear_context" | "allow_accept_edits";

export interface PermissionRuleSet {
  allow: string[];
  deny: string[];
}

export interface PermissionSettings extends PermissionRuleSet {
  mode: PermissionMode;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  risk: string;
  ruleHint: string;
}

export interface PermissionResponse {
  behavior: PermissionBehavior;
  reason: string;
  request: PermissionRequest;
}

export interface PermissionCheckParams {
  tool: Tool;
  input: Record<string, unknown>;
  cwd: string;
  mode?: PermissionMode;
  sessionRules?: PermissionRuleSet;
  settings?: PermissionSettings;
}

interface RawSettings {
  allow?: unknown;
  deny?: unknown;
  mode?: unknown;
}

const DEFAULT_PERMISSION_SETTINGS: PermissionSettings = {
  allow: [],
  deny: [],
  mode: "default",
};

const PLAN_ALLOWED_TOOLS = new Set(["Read", "Grep", "Glob"]);
const DANGEROUS_BASH_PREFIXES = [
  "rm ",
  "sudo ",
  "chmod ",
  "chown ",
  "mv ",
  "dd ",
  "mkfs",
  "shutdown",
  "reboot",
  "init 0",
  "init 6",
  "git push",
  "git reset --hard",
  "git clean -fd",
];

function normalizeRuleList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalizeMode(value: unknown): PermissionMode | undefined {
  return value === "default" || value === "plan" || value === "auto" ? value : undefined;
}

/**
 * Resolve permission settings by merging every settings source.
 *
 *   - `allow` / `deny`  → concatenated across all sources then de-duplicated
 *     (defaults first, so they always apply). De-duplication keeps the list
 *     small without changing matching behavior.
 *   - `mode`            → SECURITY-SENSITIVE. `auto` mode disables every
 *     confirmation prompt, so it must NOT be settable from a committed/checked
 *     in project (or local) settings file — otherwise a hostile repo could
 *     ship `{"mode":"auto"}` and silently bypass all permission checks. We
 *     therefore read `mode` only from non-project/local sources (user / flag /
 *     policy), later source winning.
 *
 * A malformed settings file degrades to "ignored" rather than throwing:
 * dropping a source can only REMOVE allow rules (fail-closed → more prompts,
 * never fewer), so it is safe. The malformed file is reported separately via
 * `loadSettingsDiagnostics` so the user still sees a notice.
 */
export async function loadPermissionSettings(cwd: string): Promise<PermissionSettings> {
  const sources = await loadSettingSources(cwd);

  const allow: string[] = [...DEFAULT_PERMISSION_SETTINGS.allow];
  const deny: string[] = [...DEFAULT_PERMISSION_SETTINGS.deny];
  let mode: PermissionMode | undefined;

  for (const src of sources) {
    if (!src.raw) continue;
    const raw = src.raw as RawSettings;
    allow.push(...normalizeRuleList(raw.allow));
    deny.push(...normalizeRuleList(raw.deny));
    if (!isTrustedScopeForSensitiveKeys(src.source)) continue;
    const m = normalizeMode(raw.mode);
    if (m) mode = m;
  }

  return {
    allow: dedupe(allow),
    deny: dedupe(deny),
    mode: mode ?? DEFAULT_PERMISSION_SETTINGS.mode,
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wildcardToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "i");
}

function extractBashCommand(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command.trim() : "";
}

function extractSkillName(input: Record<string, unknown>): string {
  return typeof input.skill === "string" ? input.skill.trim() : "";
}

export function matchesPermissionRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const normalizedRule = rule.trim();
  if (!normalizedRule) return false;
  if (normalizedRule === toolName) return true;

  // Wildcard match for MCP tool names: `mcp__github__*` matches every tool
  // exposed by the github MCP server. Source code uses fully qualified
  // `mcp__server__tool` names for permission rule matching to avoid
  // collisions with builtin tool names — we follow the same convention
  // and additionally support a trailing `*` for whole-server allow/deny.
  if (normalizedRule.startsWith("mcp__") && normalizedRule.includes("*")) {
    return wildcardToRegExp(normalizedRule).test(toolName);
  }

  const match = normalizedRule.match(/^([A-Za-z]+)\((.*)\)$/);
  if (!match) return false;

  const [, ruleToolName, pattern] = match;
  if (ruleToolName !== toolName) return false;

  if (toolName === "Bash") {
    const command = extractBashCommand(input);
    return wildcardToRegExp(pattern.trim()).test(command);
  }

  // Skill rules: `Skill(my-skill)` exact, `Skill(review:*)` prefix-glob.
  // The argument is the skill `name` (NOT the dirname or any args). Mirrors
  // source code's `ruleMatches()` for the SkillTool branch.
  if (toolName === "Skill") {
    const skillName = extractSkillName(input);
    if (!skillName) return false;
    const trimmedPattern = pattern.trim();
    if (trimmedPattern.includes("*")) {
      return wildcardToRegExp(trimmedPattern).test(skillName);
    }
    return trimmedPattern === skillName;
  }

  return false;
}

function matchesAnyRule(rules: string[], toolName: string, input: Record<string, unknown>): boolean {
  return rules.some((rule) => matchesPermissionRule(rule, toolName, input));
}

function findFirstMatchingRule(
  rules: string[],
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  return rules.find((rule) => matchesPermissionRule(rule, toolName, input));
}

/**
 * Sandbox auto-allow path. Mirrors source code's `checkSandboxAutoAllow`
 * in `bashPermissions.ts:1270`.
 *
 * Pre-condition: caller has confirmed the command WILL be sandboxed
 * (sandbox.enabled + autoAllowBashIfSandboxed + shouldUseSandbox).
 *
 * Decision tree:
 *   1. Any subcommand hits a Bash deny rule → deny (security boundary)
 *   2. Full command or any subcommand hits a Bash ask rule → ask
 *   3. Otherwise → allow (sandbox is the safety net)
 *
 * The per-subcommand deny check is the SECURITY-critical part: a
 * compound command like `echo hi && rm -rf /` would not match
 * `Bash(rm:*)` against the full command string. We must split first.
 */
function checkSandboxAutoAllow(
  command: string,
  rules: { allow: string[]; deny: string[] },
  sessionRules: { allow: string[]; deny: string[] },
): { behavior: PermissionBehavior; reason: string } {
  const allDenyRules = [...sessionRules.deny, ...rules.deny];
  const allAllowRules = [...sessionRules.allow, ...rules.allow];

  let subcommands: string[];
  try {
    subcommands = splitCommand(command);
  } catch {
    subcommands = [command];
  }
  if (subcommands.length === 0) subcommands = [command];

  // Pass 1: deny on any subcommand wins.
  for (const sub of subcommands) {
    const denyRule = findFirstMatchingRule(allDenyRules, "Bash", { command: sub });
    if (denyRule) {
      return { behavior: "deny", reason: `subcommand "${sub}" matched deny rule "${denyRule}"` };
    }
  }
  // Also check full-command deny (covers wildcard rules like `Bash(*evil*)`
  // that match the full string but no individual subcommand).
  const fullDeny = findFirstMatchingRule(allDenyRules, "Bash", { command });
  if (fullDeny) {
    return { behavior: "deny", reason: `command matched deny rule "${fullDeny}"` };
  }

  // Pass 2: ask on any subcommand or full command.
  for (const sub of subcommands) {
    const askRule = findFirstMatchingRule(allAllowRules, "Bash", { command: sub });
    if (askRule === undefined) continue;
    // A matching allow rule short-circuits to allow if sandboxed; we
    // continue scanning for ask-style rules separately. Easy-agent
    // doesn't have a separate ask-list (only allow/deny), so we treat
    // an allow match as "explicit allow" — return early.
    return { behavior: "allow", reason: `subcommand "${sub}" matched allow rule "${askRule}"` };
  }

  return {
    behavior: "allow",
    reason: "auto-allowed inside sandbox (autoAllowBashIfSandboxed)",
  };
}

function isDangerousBashCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return DANGEROUS_BASH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .slice(0, 3)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const compact = (text ?? "").replace(/\s+/g, " ").trim();
      return `${key}=${compact.length > 80 ? `${compact.slice(0, 77)}...` : compact}`;
    });

  return entries.length > 0 ? entries.join(", ") : "No arguments";
}

export function summarizePermissionRequest(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const command = extractBashCommand(input);
    return command ? `command=${command}` : "command=<empty>";
  }
  return summarizeInput(input);
}

export function buildPermissionRuleHint(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    const command = extractBashCommand(input);
    const firstToken = command.split(/\s+/)[0];
    return firstToken ? `Bash(${firstToken} *)` : "Bash";
  }
  if (toolName === "Skill") {
    const skillName = extractSkillName(input);
    return skillName ? `Skill(${skillName})` : "Skill";
  }
  return toolName;
}

function getRiskLabel(tool: Tool, input: Record<string, unknown>): string {
  if (tool.name === "Bash") {
    const command = extractBashCommand(input);
    if (isDangerousBashCommand(command)) {
      return "High risk: destructive shell command detected";
    }
    if (isReadOnlyCommand(command)) {
      return "Low risk: read-only shell command";
    }
    return "Medium risk: shell command may change files or git state";
  }

  if (tool.isReadOnly()) {
    return "Low risk: read-only tool";
  }

  if (tool.name === "Write" || tool.name === "Edit") {
    return "Medium risk: writes files in the workspace";
  }

  return "Medium risk: operation may change local state";
}

export async function checkPermission(params: PermissionCheckParams): Promise<PermissionResponse> {
  const settings = params.settings ?? (await loadPermissionSettings(params.cwd));
  const mode = params.mode ?? settings.mode;
  const sessionRules = params.sessionRules ?? { allow: [], deny: [] };
  const request: PermissionRequest = {
    toolName: params.tool.name,
    input: params.input,
    summary: summarizePermissionRequest(params.tool.name, params.input),
    risk: getRiskLabel(params.tool, params.input),
    ruleHint: buildPermissionRuleHint(params.tool.name, params.input),
  };

  if (mode === "auto") {
    return { behavior: "allow", reason: "auto mode allows all operations", request };
  }

  // Always-allow set — tools whose side effects are confined to
  // Easy Agent's own ~/.easy-agent state directory and never touch the
  // user's workspace. They are auto-approved in every mode (including
  // Plan Mode) so the model can plan / coordinate without UI prompts.
  //
  // Two groups:
  //   1. TodoWrite + Task V2 tools  →  planning state only
  //   2. Agent Teams (Stage 21)     →  team file + mailbox under
  //      ~/.easy-agent/teams. Mirrors Claude Code source's
  //      `SAFE_YOLO_ALLOWLISTED_TOOLS` set in
  //      utils/permissions/classifierDecision.ts:78-83, whose comment
  //      reads: "Swarm coordination (internal mailbox/team state only
  //      — teammates have their own permission checks, so no actual
  //      security bypass)."
  //
  //      Note: TeamDelete additionally cleans up agent-owned git
  //      worktrees, but `removeAgentWorktree` refuses to delete dirty
  //      ones — so the user's uncommitted work is never destroyed
  //      without their consent.
  if (
    params.tool.name === "TodoWrite" ||
    params.tool.name === "TaskCreate" ||
    params.tool.name === "TaskUpdate" ||
    params.tool.name === "TaskGet" ||
    params.tool.name === "TaskList" ||
    params.tool.name === "TeamCreate" ||
    params.tool.name === "TeamDelete" ||
    params.tool.name === "SendMessage"
  ) {
    return { behavior: "allow", reason: `${params.tool.name} writes coordination-only state`, request };
  }

  // Plan mode: allow read-only tools, plan mode tools, plan file writes; deny everything else
  if (mode === "plan") {
    if (PLAN_ALLOWED_TOOLS.has(params.tool.name)) {
      return { behavior: "allow", reason: "read-only tool allowed in plan mode", request };
    }
    if (params.tool.name === "EnterPlanMode" || params.tool.name === "ExitPlanMode") {
      return { behavior: "ask", reason: "plan mode transition requires confirmation", request };
    }
    if (params.tool.name === "Bash") {
      const command = extractBashCommand(params.input);
      if (isReadOnlyCommand(command)) {
        return { behavior: "allow", reason: "read-only shell command allowed in plan mode", request };
      }
      return { behavior: "deny", reason: "plan mode blocks non-read-only Bash commands", request };
    }
    // Allow writing to the plan file
    if (params.tool.name === "Write") {
      const filePath = typeof params.input.file_path === "string" ? params.input.file_path : "";
      const planPath = getPlanFilePath();
      if (filePath && path.resolve(filePath) === path.resolve(planPath)) {
        return { behavior: "allow", reason: "writing to plan file is allowed in plan mode", request };
      }
    }
    return { behavior: "deny", reason: `plan mode blocks ${params.tool.name}`, request };
  }

  // EnterPlanMode always requires user approval
  if (params.tool.name === "EnterPlanMode") {
    return { behavior: "ask", reason: "entering plan mode requires confirmation", request };
  }

  if (params.tool.name === "Bash") {
    const command = extractBashCommand(params.input);
    if (isReadOnlyCommand(command)) {
      return { behavior: "allow", reason: "read-only shell command", request };
    }
  } else if (params.tool.isReadOnly()) {
    return { behavior: "allow", reason: "read-only tool", request };
  }

  if (matchesAnyRule(sessionRules.deny, params.tool.name, params.input) || matchesAnyRule(settings.deny, params.tool.name, params.input)) {
    return { behavior: "deny", reason: "matched deny rule", request };
  }

  if (matchesAnyRule(sessionRules.allow, params.tool.name, params.input) || matchesAnyRule(settings.allow, params.tool.name, params.input)) {
    return { behavior: "allow", reason: "matched allow rule", request };
  }

  // Sandbox auto-allow gate. If the user has the sandbox on AND policy
  // says "auto-allow when sandboxed", we skip the confirmation dialog
  // for Bash — but only after running per-subcommand deny checks. The
  // sandbox is the ultimate safety net; explicit deny rules still apply.
  if (params.tool.name === "Bash") {
    const command = extractBashCommand(params.input);
    let sandboxSettings;
    try {
      sandboxSettings = await loadSandboxSettings(params.cwd);
    } catch {
      sandboxSettings = null;
    }
    if (
      sandboxSettings?.enabled &&
      sandboxSettings.autoAllowBashIfSandboxed &&
      shouldUseSandbox(
        {
          command,
          dangerouslyDisableSandbox:
            params.input.dangerouslyDisableSandbox === true,
        },
        sandboxSettings,
      )
    ) {
      const decision = checkSandboxAutoAllow(
        command,
        { allow: settings.allow, deny: settings.deny },
        sessionRules,
      );
      return { behavior: decision.behavior, reason: decision.reason, request };
    }
  }

  if (params.tool.name === "Bash" && isDangerousBashCommand(extractBashCommand(params.input))) {
    return { behavior: "ask", reason: "dangerous shell command requires confirmation", request };
  }

  return { behavior: "ask", reason: "operation requires confirmation", request };
}

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "../tools/Tool.js";
import { isReadOnlyCommand } from "../tools/bashTool.js";
import { getPlanFilePath } from "../context/plans.js";

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

async function readSettingsFile(filePath: string): Promise<Partial<PermissionSettings>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as RawSettings;
    return {
      allow: normalizeRuleList(parsed.allow),
      deny: normalizeRuleList(parsed.deny),
      ...(normalizeMode(parsed.mode) ? { mode: normalizeMode(parsed.mode) } : {}),
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in permissions settings: ${filePath}`);
    }
    throw error;
  }
}

export async function loadPermissionSettings(cwd: string): Promise<PermissionSettings> {
  const userSettingsPath = path.join(os.homedir(), ".agent", "settings.json");
  const projectSettingsPath = path.join(cwd, ".agent", "settings.json");

  const [userSettings, projectSettings] = await Promise.all([
    readSettingsFile(userSettingsPath),
    readSettingsFile(projectSettingsPath),
  ]);

  return {
    allow: [
      ...DEFAULT_PERMISSION_SETTINGS.allow,
      ...(userSettings.allow ?? []),
      ...(projectSettings.allow ?? []),
    ],
    deny: [
      ...DEFAULT_PERMISSION_SETTINGS.deny,
      ...(userSettings.deny ?? []),
      ...(projectSettings.deny ?? []),
    ],
    mode: projectSettings.mode ?? userSettings.mode ?? DEFAULT_PERMISSION_SETTINGS.mode,
  };
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

export function matchesPermissionRule(rule: string, toolName: string, input: Record<string, unknown>): boolean {
  const normalizedRule = rule.trim();
  if (!normalizedRule) return false;
  if (normalizedRule === toolName) return true;

  const match = normalizedRule.match(/^([A-Za-z]+)\((.*)\)$/);
  if (!match) return false;

  const [, ruleToolName, pattern] = match;
  if (ruleToolName !== toolName) return false;

  if (toolName === "Bash") {
    const command = extractBashCommand(input);
    return wildcardToRegExp(pattern.trim()).test(command);
  }

  return false;
}

function matchesAnyRule(rules: string[], toolName: string, input: Record<string, unknown>): boolean {
  return rules.some((rule) => matchesPermissionRule(rule, toolName, input));
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

  // TodoWrite only mutates in-memory session state — no filesystem or
  // shell side effects — so it never needs user approval, in any mode.
  // This mirrors source code's `shouldDefer: true` + `checkPermissions:
  // () => allow` combo on TodoWriteTool, and keeps the tool usable inside
  // Plan Mode where the model is expected to draft its task list.
  if (params.tool.name === "TodoWrite") {
    return { behavior: "allow", reason: "TodoWrite writes session-only state", request };
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

  if (params.tool.name === "Bash" && isDangerousBashCommand(extractBashCommand(params.input))) {
    return { behavior: "ask", reason: "dangerous shell command requires confirmation", request };
  }

  return { behavior: "ask", reason: "operation requires confirmation", request };
}

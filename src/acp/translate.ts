/**
 * Translation between Easy Agent's session SDK and the Agent Client Protocol.
 *
 * Pure functions: SDK shapes in, ACP shapes out (and the reverse for prompts
 * and permission answers). The connection logic lives in `agent.ts`.
 */

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { BUILTIN_COMMAND_HELP } from "../commands/builtinCommandHelp.js";
import type {
  ImageInput,
  InteractionResponse,
  McpServerConfig,
  PermissionInteraction,
  PermissionMode,
  PlanApprovalInteraction,
  QuestionInteraction,
  RuntimeCapabilities,
  TurnResult,
} from "../sdk/index.js";

// ─── ACP shapes (the subset this agent produces and consumes) ────────────

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string | null }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string | null; title?: string | null }
  | {
      type: "resource";
      resource:
        | { uri: string; text: string; mimeType?: string | null }
        | { uri: string; blob: string; mimeType?: string | null };
    };

export type ToolCallContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string };

export interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call"; title: string } & ToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & ToolCallFields)
  | {
      sessionUpdate: "plan";
      entries: {
        content: string;
        priority: "high" | "medium" | "low";
        status: "pending" | "in_progress" | "completed";
      }[];
    }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "usage_update"; used: number; size: number };

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export type McpServerSpec =
  | { name: string; command: string; args: string[]; env?: { name: string; value: string }[] }
  | { type: "http" | "sse"; name: string; url: string; headers: { name: string; value: string }[] };

// ─── Modes ───────────────────────────────────────────────────────────────

export const SESSION_MODES: readonly { id: PermissionMode; name: string; description: string }[] = [
  { id: "default", name: "Default", description: "Ask before editing files or running commands" },
  { id: "plan", name: "Plan", description: "Read-only research; propose a plan before changing anything" },
  { id: "auto", name: "Auto", description: "A classifier approves safe tool calls; risky ones still ask" },
];

export function modeState(current: PermissionMode) {
  return { currentModeId: current, availableModes: SESSION_MODES.map((mode) => ({ ...mode })) };
}

// ─── Commands ────────────────────────────────────────────────────────────

/** Commands that open a terminal view, an editor, or the clipboard; an editor cannot show them. */
const TERMINAL_ONLY_COMMANDS = new Set(["copy", "diff", "exit", "memory", "permissions", "plugin", "resume"]);

export function availableCommands(capabilities: RuntimeCapabilities): AvailableCommand[] {
  const commands: AvailableCommand[] = [];
  for (const { usage, description } of BUILTIN_COMMAND_HELP) {
    const match = /^\/([a-z][\w-]*)(?:\s+(.+))?$/.exec(usage);
    if (!match || TERMINAL_ONLY_COMMANDS.has(match[1]!)) continue;
    commands.push({ name: match[1]!, description, ...(match[2] ? { input: { hint: match[2] } } : {}) });
  }
  for (const { name, description } of [...capabilities.skills, ...capabilities.userCommands]) {
    if (commands.some((command) => command.name === name)) continue;
    commands.push({ name, description: description || name, input: { hint: "arguments" } });
  }
  return commands;
}

// ─── Prompts ─────────────────────────────────────────────────────────────

export class PromptContentError extends Error {}

/** Turn ACP prompt blocks into the text and images of one SDK turn. */
export function promptToInput(prompt: readonly ContentBlock[]): { text: string; images: ImageInput[] } {
  const parts: string[] = [];
  const images: ImageInput[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        images.push({ data: block.data, mimeType: block.mimeType });
        break;
      case "resource_link":
        parts.push(`[Referenced: ${uriToPath(block.uri)}]`);
        break;
      case "resource": {
        const { resource } = block;
        if ("text" in resource) {
          parts.push(`<context source="${uriToPath(resource.uri)}">\n${resource.text}\n</context>`);
        } else if (resource.mimeType?.startsWith("image/")) {
          images.push({ data: resource.blob, mimeType: resource.mimeType });
        } else {
          parts.push(`[Attached binary resource not included: ${uriToPath(resource.uri)}]`);
        }
        break;
      }
      case "audio":
        throw new PromptContentError("Audio prompts are not supported.");
    }
  }
  return { text: parts.join("\n\n"), images };
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:\/)/, "$1"));
  } catch {
    return uri;
  }
}

// ─── Turns ───────────────────────────────────────────────────────────────

/**
 * The stop reason of a turn. A plan decision ends the planning turn and runs
 * a follow-up, so the reason is the one of the last turn that ran.
 */
export function stopReason(result: TurnResult): { stopReason: StopReason } | { failed: true } {
  let last = result;
  while (last.followUps.length > 0) last = last.followUps.at(-1)!;
  switch (last.reason) {
    case "aborted":
      return { stopReason: "cancelled" };
    case "model_error":
      return { failed: true };
    case "max_turns":
      return { stopReason: "max_turn_requests" };
    case "blocking_limit":
      return { stopReason: "max_tokens" };
    default:
      return { stopReason: "end_turn" };
  }
}

// ─── Tool calls ──────────────────────────────────────────────────────────

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  ReadMcpResource: "read",
  ListMcpResources: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  ToolSearch: "search",
  Bash: "execute",
  PowerShell: "execute",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "think",
  EnterPlanMode: "switch_mode",
  ExitPlanMode: "switch_mode",
};

export function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? "other";
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const clip = (text: string, max = 80): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** A one-line title for a tool call, from its name and input. */
export function toolTitle(name: string, input: Record<string, unknown> = {}): string {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `${name} ${file}` : name;
    case "Bash":
    case "PowerShell":
      return str(input.command) ? clip(str(input.command)!) : name;
    case "Grep":
      return str(input.pattern) ? `Search for ${clip(str(input.pattern)!, 60)}${file ? ` in ${file}` : ""}` : name;
    case "Glob":
      return str(input.pattern) ? `Find ${clip(str(input.pattern)!, 60)}` : name;
    case "WebFetch":
      return str(input.url) ? `Fetch ${clip(str(input.url)!)}` : name;
    case "WebSearch":
      return str(input.query) ? `Search the web: ${clip(str(input.query)!, 60)}` : name;
    case "Agent":
      return str(input.description) ? `Agent: ${clip(str(input.description)!, 60)}` : name;
    case "Skill":
      return str(input.skill) ? `Skill: ${str(input.skill)}` : name;
    default:
      return name;
  }
}

/** Files the tool call reads or changes, for "follow the agent" in the editor. */
export function toolLocations(input: Record<string, unknown> = {}): { path: string; line?: number }[] {
  const file = str(input.file_path) ?? str(input.notebook_path);
  if (!file) return [];
  const line = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : undefined;
  return [{ path: file, ...(line ? { line } : {}) }];
}

/** A preview of a file change, shown while the call waits for permission and after it ran. */
export function toolDiffs(name: string, input: Record<string, unknown> = {}): ToolCallContent[] {
  const file = str(input.file_path);
  if (!file) return [];
  if (name === "Write" && typeof input.content === "string") {
    return [{ type: "diff", path: file, oldText: null, newText: input.content }];
  }
  if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    return [{ type: "diff", path: file, oldText: input.old_string, newText: input.new_string }];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.flatMap((edit: unknown) => {
      const { old_string, new_string } = (edit ?? {}) as Record<string, unknown>;
      return typeof old_string === "string" && typeof new_string === "string"
        ? [{ type: "diff" as const, path: file, oldText: old_string, newText: new_string }]
        : [];
    });
  }
  return [];
}

const MAX_TOOL_OUTPUT = 20_000;

/** Text of a tool result, capped so a large output does not flood the editor. */
export function toolResultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              (block as { type?: string }).type === "text"
                ? ((block as { text?: string }).text ?? "")
                : `[${(block as { type?: string }).type ?? "content"}]`,
            )
            .join("\n")
        : "";
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more characters)`
    : text;
}

/** Everything known about a tool call once its input has arrived. */
export function describeToolCall(toolCallId: string, name: string, input: Record<string, unknown>): ToolCallFields {
  return {
    toolCallId,
    title: toolTitle(name, input),
    kind: toolKind(name),
    rawInput: input,
    locations: toolLocations(input),
  };
}

// ─── Permission requests ────────────────────────────────────────────────

export const PERMISSION_OPTIONS = {
  allowOnce: "allow-once",
  allowAlways: "allow-always",
  reject: "reject-once",
} as const;

export function permissionOptions(request: PermissionInteraction): PermissionOption[] {
  return [
    { optionId: PERMISSION_OPTIONS.allowOnce, name: "Allow", kind: "allow_once" },
    {
      optionId: PERMISSION_OPTIONS.allowAlways,
      name: `Always allow ${request.ruleHint} this session`,
      kind: "allow_always",
    },
    { optionId: PERMISSION_OPTIONS.reject, name: "Reject", kind: "reject_once" },
  ];
}

export const PLAN_OPTIONS = {
  clearContext: "approve-clear-context",
  acceptEdits: "approve-accept-edits",
  manual: "approve-manual",
  reject: "keep-planning",
} as const;

export function planApprovalOptions(): PermissionOption[] {
  return [
    { optionId: PLAN_OPTIONS.clearContext, name: "Yes, clear context and auto-accept edits", kind: "allow_always" },
    { optionId: PLAN_OPTIONS.acceptEdits, name: "Yes, and auto-accept edits", kind: "allow_always" },
    { optionId: PLAN_OPTIONS.manual, name: "Yes, approve each edit", kind: "allow_once" },
    { optionId: PLAN_OPTIONS.reject, name: "No, keep planning", kind: "reject_once" },
  ];
}

export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

/** The SDK response for the option the user picked; anything unexpected denies. */
export function permissionResponse(
  request: PermissionInteraction | PlanApprovalInteraction,
  outcome: PermissionOutcome | undefined,
): InteractionResponse {
  const optionId = outcome?.outcome === "selected" ? outcome.optionId : undefined;
  if (request.kind === "plan_approval") {
    switch (optionId) {
      case PLAN_OPTIONS.clearContext:
        return { decision: "approve", clearContext: true, acceptEdits: true };
      case PLAN_OPTIONS.acceptEdits:
        return { decision: "approve", acceptEdits: true };
      case PLAN_OPTIONS.manual:
        return { decision: "approve" };
      default:
        return { decision: "reject" };
    }
  }
  if (optionId === PERMISSION_OPTIONS.allowOnce) return { decision: "allow_once" };
  if (optionId === PERMISSION_OPTIONS.allowAlways) return { decision: "allow_always" };
  return { decision: "deny" };
}

// ─── Questions (form elicitation) ───────────────────────────────────────

/** A flat form with one field per question; multiple-choice fields list the option labels. */
export function questionForm(request: QuestionInteraction) {
  const properties: Record<string, unknown> = {};
  request.questions.forEach((question, index) => {
    const labels = question.options.map((option) => option.label);
    properties[`q${index + 1}`] = question.multiSelect
      ? {
          type: "array",
          title: question.header || question.question,
          description: question.question,
          items: { type: "string", enum: labels },
        }
      : { type: "string", title: question.header || question.question, description: question.question, enum: labels };
  });
  return {
    message: request.questions.length === 1 ? request.questions[0]!.question : "The agent has a few questions.",
    requestedSchema: { type: "object", properties, required: Object.keys(properties) },
  };
}

export function questionResponse(
  request: QuestionInteraction,
  result: { action: string; content?: Record<string, unknown> | null } | undefined,
): InteractionResponse {
  if (result?.action !== "accept" || !result.content) return { cancelled: true };
  const answers: Record<string, string> = {};
  request.questions.forEach((question, index) => {
    const value = result.content![`q${index + 1}`];
    const answer = Array.isArray(value) ? value.filter((item) => typeof item === "string").join(", ") : value;
    if (typeof answer === "string" && answer) answers[question.question] = answer;
  });
  return Object.keys(answers).length > 0 ? { answers } : { cancelled: true };
}

// ─── MCP servers ────────────────────────────────────────────────────────

export function mcpServerConfigs(servers: readonly McpServerSpec[]): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if ("command" in server) {
      configs[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        ...(server.env?.length ? { env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])) } : {}),
      };
    } else {
      configs[server.name] = {
        type: server.type,
        url: server.url,
        ...(server.headers.length
          ? { headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])) }
          : {}),
      };
    }
  }
  return configs;
}

// ─── Replay ─────────────────────────────────────────────────────────────

/** Context the engine adds on its own; not shown when a conversation is replayed. */
const HIDDEN_MESSAGE_PREFIXES = [
  "[session-start]",
  "[plan_mode_attachment]",
  "[plan_mode_exit]",
  "[ultrathink]",
  "[context_update]",
  "[task-notification]",
  "[skill_invocation:",
  "[command_invocation:",
  "[CompactBoundary]",
];

/** The updates that show a saved conversation the way it happened. */
export function replayUpdates(messages: readonly MessageParam[]): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  for (const message of messages) {
    const blocks =
      typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === "text") {
        const text = block.text.replace(/<\/?command-(name|args|message)>/g, " ").trim();
        if (!text || HIDDEN_MESSAGE_PREFIXES.some((prefix) => text.startsWith(prefix))) continue;
        updates.push({
          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: text.replace(/^\[user-context\][\s\S]*?\n\n/, "") },
        });
      } else if (block.type === "thinking" && message.role === "assistant") {
        updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
      } else if (block.type === "image" && message.role === "user" && block.source.type === "base64") {
        updates.push({
          sessionUpdate: "user_message_chunk",
          content: { type: "image", data: block.source.data, mimeType: block.source.media_type },
        });
      } else if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        updates.push({
          sessionUpdate: "tool_call",
          ...describeToolCall(block.id, block.name, input),
          title: toolTitle(block.name, input),
          status: "pending",
          content: toolDiffs(block.name, input),
        });
      } else if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: block.tool_use_id,
          status: block.is_error ? "failed" : "completed",
          ...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
        });
      }
    }
  }
  return updates;
}

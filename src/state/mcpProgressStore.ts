import { defineSessionState } from "./sessionScope.js";

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

type Listener = (toolUseId: string, progress: McpProgress | null) => void;

/** MCP progress notifications for this session scope's in-flight tool calls. */
const mcpProgressState = defineSessionState("mcpProgress", () => ({
  values: new Map<string, McpProgress>(),
  listeners: new Set<Listener>(),
}));

export function setMcpProgress(toolUseId: string, progress: McpProgress): void {
  mcpProgressState().values.set(toolUseId, progress);
  for (const listener of mcpProgressState().listeners) listener(toolUseId, progress);
}

export function clearMcpProgress(toolUseId: string): void {
  if (!mcpProgressState().values.delete(toolUseId)) return;
  for (const listener of mcpProgressState().listeners) listener(toolUseId, null);
}

export function clearAllMcpProgress(): void {
  for (const id of mcpProgressState().values.keys()) clearMcpProgress(id);
}

export function subscribeMcpProgress(listener: Listener): () => void {
  const { listeners } = mcpProgressState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

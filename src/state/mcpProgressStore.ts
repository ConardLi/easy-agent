export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

type Listener = (toolUseId: string, progress: McpProgress | null) => void;
const values = new Map<string, McpProgress>();
const listeners = new Set<Listener>();

export function setMcpProgress(toolUseId: string, progress: McpProgress): void {
  values.set(toolUseId, progress);
  for (const listener of listeners) listener(toolUseId, progress);
}

export function clearMcpProgress(toolUseId: string): void {
  if (!values.delete(toolUseId)) return;
  for (const listener of listeners) listener(toolUseId, null);
}

export function clearAllMcpProgress(): void {
  for (const id of values.keys()) clearMcpProgress(id);
}

export function subscribeMcpProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

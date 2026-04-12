import { loadRelevantMemories } from "./memdir.js";

export async function findRelevantMemories(
  cwd: string,
  query: string,
  options?: { alreadySurfaced?: ReadonlySet<string>; ignoreMemory?: boolean },
): Promise<string[]> {
  return loadRelevantMemories(cwd, query, options);
}

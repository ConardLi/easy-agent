/** Turn a command-line argument into an Agent name or a spec read from a file. */

import { readFile } from "node:fs/promises";
import * as path from "node:path";

export type HarnessTarget = { name: string } | { spec: unknown; file: string };

/** A path (contains a separator or ends in `.json`) is read as a spec; anything else is a name. */
export async function harnessTarget(argument: string, cwd: string): Promise<HarnessTarget> {
  const looksLikePath = argument.includes("/") || argument.includes("\\") || argument.endsWith(".json");
  if (!looksLikePath) return { name: argument };
  const file = path.resolve(cwd, argument);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { spec: JSON.parse(text), file };
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

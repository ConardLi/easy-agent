import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The `eagent` entry script the desktop app runs with Electron's Node. In
 * development it is the repository's own build (`npm run build` at the
 * repository root), linked as the `eagent` dependency.
 */
export function bundledAgentScript(): string {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("eagent/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> };
  const entry = typeof bin === "string" ? bin : bin.eagent;
  if (!entry) throw new Error("eagent/package.json has no eagent bin entry");
  return join(dirname(manifest), entry);
}

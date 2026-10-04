/**
 * Writes the ACP Registry entry for the current version:
 * .acp-registry/easy-agent/{agent.json,icon.svg}. Copy that folder into a
 * fork of https://github.com/agentclientprotocol/registry after the version is
 * published to npm (the registry checks that the package exists).
 *
 * Run: node --import tsx scripts/acp-registry-entry.ts [--out <dir>]
 */

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ACP_REGISTRY_ID = "easy-agent";

export async function buildAcpRegistryEntry(): Promise<Record<string, unknown>> {
  const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    license: string;
  };
  return {
    id: ACP_REGISTRY_ID,
    name: "Easy Agent",
    version: pkg.version,
    description:
      "Open-source coding agent that reads, edits, and runs your code under permission rules, with OS sandboxing, MCP, skills, and Anthropic, OpenAI-compatible, Gemini, or local models.",
    repository: "https://github.com/ConardLi/easy-agent",
    website: "https://github.com/ConardLi/easy-agent/blob/main/docs/acp.md",
    authors: ["ConardLi"],
    license: pkg.license,
    license_url: "https://github.com/ConardLi/easy-agent/blob/main/LICENSE",
    distribution: { npx: { package: `${pkg.name}@${pkg.version}`, args: ["--acp"] } },
  };
}

export async function writeAcpRegistryEntry(outDir: string): Promise<string> {
  const dir = path.join(outDir, ACP_REGISTRY_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "agent.json"), `${JSON.stringify(await buildAcpRegistryEntry(), null, 2)}\n`);
  await copyFile(path.join(PROJECT_ROOT, "assets", "acp-registry-icon.svg"), path.join(dir, "icon.svg"));
  return dir;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex !== -1 ? path.resolve(process.argv[outIndex + 1]!) : path.join(PROJECT_ROOT, ".acp-registry");
  const dir = await writeAcpRegistryEntry(outDir);
  process.stdout.write(`Wrote ${path.relative(process.cwd(), dir)}/agent.json and icon.svg\n`);
}

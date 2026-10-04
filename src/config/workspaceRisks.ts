/**
 * Project configuration that takes effect only in a trusted workspace.
 *
 * Used by the trust dialog to explain what trusting enables, and at startup
 * to tell the user which project settings an untrusted workspace ignores.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadSettingSources } from "./sources.js";

/** Inspect project + local settings for items worth warning about. */
export async function detectWorkspaceRisks(cwd: string): Promise<string[]> {
  const sources = await loadSettingSources(cwd);
  const risks = new Set<string>();
  for (const src of sources) {
    if (src.source !== "project" && src.source !== "local") continue;
    const raw = src.raw;
    if (!raw) continue;
    if (raw["env"] && typeof raw["env"] === "object" && Object.keys(raw["env"] as Record<string, unknown>).length > 0) {
      risks.add("environment variables");
    }
    if (
      raw["models"] &&
      typeof raw["models"] === "object" &&
      Object.values(raw["models"] as Record<string, unknown>).some((profile) => {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
        const value = profile as Record<string, unknown>;
        return ["protocol", "baseURL", "apiKey", "headers"].some((key) => value[key] !== undefined);
      })
    ) {
      risks.add("model provider endpoints or credentials");
    }
    if (raw["apiKeyHelper"]) risks.add("an API key helper command");
    if (Array.isArray(raw["additionalDirectories"]) && raw["additionalDirectories"].length > 0) {
      risks.add("additional filesystem roots");
    }
    if (raw["hooks"] && typeof raw["hooks"] === "object") risks.add("lifecycle hooks (run shell commands)");
    if (raw["statusLine"]) risks.add("a custom status line command");
    if (raw["mcpServers"] && typeof raw["mcpServers"] === "object") risks.add("MCP servers");
    if (
      raw["enabledPlugins"] &&
      typeof raw["enabledPlugins"] === "object" &&
      Object.values(raw["enabledPlugins"] as Record<string, unknown>).some((value) => value === true)
    ) {
      risks.add("project plugins (may include hooks, MCP, or LSP servers)");
    }
    const allow = raw["allow"];
    if (Array.isArray(allow) && allow.some((r) => typeof r === "string" && r.startsWith("Bash("))) {
      risks.add("Bash allow-rules");
    }
  }
  try {
    await fs.access(path.join(cwd, ".env"));
    risks.add("a project .env file");
  } catch {
    // Missing or unreadable files add no trust-dialog risk item.
  }
  return [...risks];
}

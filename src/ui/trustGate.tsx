/**
 * Trust gate — runs before the main REPL renders.
 *
 * If the current directory isn't trusted yet, it renders the TrustDialog in a
 * standalone Ink root and waits for the user's decision. Trusting persists the
 * decision and continues; declining returns false so the entrypoint can exit.
 *
 * Non-interactive trust policy is resolved by the CLI before project settings
 * are applied or execution-capable extensions are initialized.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isProjectTrusted, trustProject } from "../config/globalState.js";
import { loadSettingSources } from "../config/sources.js";

/** Inspect project + local settings for items worth warning about. */
export async function detectRisks(cwd: string): Promise<string[]> {
  const sources = await loadSettingSources(cwd);
  const risks = new Set<string>();
  for (const src of sources) {
    if (src.source !== "project" && src.source !== "local") continue;
    const raw = src.raw;
    if (!raw) continue;
    if (
      raw["env"] &&
      typeof raw["env"] === "object" &&
      Object.keys(raw["env"] as Record<string, unknown>).length > 0
    ) {
      risks.add("environment variables");
    }
    if (
      raw["models"] &&
      typeof raw["models"] === "object" &&
      Object.values(raw["models"] as Record<string, unknown>).some((profile) => {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
        const value = profile as Record<string, unknown>;
        return ["protocol", "baseURL", "apiKey", "headers"].some(
          (key) => value[key] !== undefined,
        );
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
      Object.values(raw["enabledPlugins"] as Record<string, unknown>).some(
        (value) => value === true,
      )
    ) {
      risks.add("project plugins (may include hooks or MCP servers)");
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

/**
 * Ensure the cwd is trusted. Returns true when trusted (already, or after the
 * user accepts) and false when the user declines. Non-TTY sessions are never
 * prompted and return false (run untrusted).
 */
export async function ensureTrusted(cwd: string): Promise<boolean> {
  if (await isProjectTrusted(cwd)) return true;
  if (!process.stdin.isTTY) return false;

  const risks = await detectRisks(cwd);

  const React = await import("react");
  const { render } = await import("ink");
  const { TrustDialog } = await import("./components/TrustDialog.js");

  return new Promise<boolean>((resolve) => {
    const instance = render(
      React.createElement(TrustDialog, {
        cwd,
        risks,
        onDecision: (trust: boolean) => {
          const finish = async () => {
            if (trust) await trustProject(cwd);
            instance.unmount();
            resolve(trust);
          };
          void finish();
        },
      }),
      { exitOnCtrlC: false },
    );
  });
}

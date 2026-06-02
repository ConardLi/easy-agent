/**
 * Trust gate — runs before the main REPL renders.
 *
 * If the current directory isn't trusted yet, it renders the TrustDialog in a
 * standalone Ink root and waits for the user's decision. Trusting persists the
 * decision and continues; declining returns false so the entrypoint can exit.
 *
 * Non-interactive invocations (no TTY) never prompt — they simply run
 * untrusted, which means project/local hooks and statusLine commands are not
 * executed (enforced in their loaders via the trusted source set).
 */

import { isProjectTrusted, trustProject } from "../config/globalState.js";
import { loadSettingSources } from "../config/sources.js";

/** Inspect project + local settings for items worth warning about. */
async function detectRisks(cwd: string): Promise<string[]> {
  const sources = await loadSettingSources(cwd);
  const risks = new Set<string>();
  for (const src of sources) {
    if (src.source !== "project" && src.source !== "local") continue;
    const raw = src.raw;
    if (!raw) continue;
    if (raw["hooks"] && typeof raw["hooks"] === "object") risks.add("lifecycle hooks (run shell commands)");
    if (raw["statusLine"]) risks.add("a custom status line command");
    if (raw["mcpServers"] && typeof raw["mcpServers"] === "object") risks.add("MCP servers");
    if (raw["mode"] === "auto") risks.add('permission mode "auto" (ignored until trusted)');
    const allow = raw["allow"];
    if (Array.isArray(allow) && allow.some((r) => typeof r === "string" && r.startsWith("Bash("))) {
      risks.add("Bash allow-rules");
    }
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

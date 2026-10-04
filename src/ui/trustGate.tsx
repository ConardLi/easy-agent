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

import { isProjectTrusted, trustProject } from "../config/globalState.js";
import { detectWorkspaceRisks } from "../config/workspaceRisks.js";

/**
 * Ensure the cwd is trusted. Returns true when trusted (already, or after the
 * user accepts) and false when the user declines. Non-TTY sessions are never
 * prompted and return false (run untrusted).
 */
export async function ensureTrusted(cwd: string): Promise<boolean> {
  if (await isProjectTrusted(cwd)) return true;
  if (!process.stdin.isTTY) return false;

  const risks = await detectWorkspaceRisks(cwd);

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

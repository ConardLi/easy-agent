/**
 * Write plain text to the system clipboard.
 *
 * The companion to `ui/utils/screenshotClipboard.ts` (which *reads* an image
 * off the clipboard): this *writes* text to it by piping the payload into the
 * platform's clipboard CLI — macOS `pbcopy`, Windows `clip`, Linux `xclip` /
 * `xsel` / `wl-copy`. No third-party dependency; we just spawn the binary and
 * feed it on stdin.
 *
 * Lives in `utils/` (not `ui/`) so the core layer (`/copy` in the QueryEngine)
 * can use it without reaching up into the UI layer.
 */

import { spawn } from "node:child_process";

export type ClipboardWriteResult =
  | { ok: true; tool: string }
  | { ok: false; error: string };

/** Spawn `bin args`, write `text` to its stdin, resolve when it exits 0. */
function pipeToProcess(bin: string, args: string[], text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with code ${code}`));
    });
    child.stdin.on("error", reject);
    child.stdin.end(text);
  });
}

/** Candidate clipboard-write tools, in priority order, per platform. */
function clipboardWriters(): [string, string[]][] {
  switch (process.platform) {
    case "darwin":
      return [["pbcopy", []]];
    case "win32":
      return [["clip", []]];
    default:
      return [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];
  }
}

/**
 * Copy `text` to the system clipboard. Tries each platform candidate in turn
 * and returns the first that succeeds; otherwise a human-readable error with
 * an install hint.
 */
export async function writeTextToClipboard(text: string): Promise<ClipboardWriteResult> {
  const candidates = clipboardWriters();
  for (const [bin, args] of candidates) {
    try {
      await pipeToProcess(bin, args, text);
      return { ok: true, tool: bin };
    } catch {
      // Tool missing or failed — try the next candidate.
    }
  }
  const hint =
    process.platform === "linux"
      ? " Install one of: wl-copy (wl-clipboard), xclip, or xsel."
      : "";
  return { ok: false, error: `No working clipboard tool found.${hint}` };
}

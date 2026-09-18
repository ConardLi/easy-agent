/**
 * Read an image from the system clipboard and persist it to a temp PNG.
 *
 * Mirrors the source's `screenshotClipboard`: it shells out to the
 * platform's clipboard-image tool (macOS `pngpaste`, Linux `xclip`/`xsel`,
 * Windows PowerShell). The returned file path is then injected into the
 * prompt as an `@path` token so it flows through the same image-attachment
 * pipeline as a typed `@image.png` reference.
 *
 * No image bytes live in this module — we write straight to disk and hand
 * back a path, keeping the clipboard plumbing independent of the API layer.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PRIVATE_IMAGE_MODE = 0o600;

export type ClipboardImageResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function tempImagePath(): string {
  const name = `easy-agent-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  return path.join(os.tmpdir(), name);
}

/** Whether a freshly written candidate file actually received image bytes. */
async function hasBytes(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function protectTempImage(file: string): Promise<void> {
  if (process.platform !== "win32") await fs.chmod(file, PRIVATE_IMAGE_MODE);
}

/**
 * macOS without any extra install: AppleScript coerces the clipboard to PNG
 * (`«class PNGf»`) and writes it out. Works for screenshots (Cmd+Ctrl+Shift+4)
 * and copied images alike; returns "none" when the clipboard isn't an image.
 */
async function readMacViaOsascript(out: string): Promise<ClipboardImageResult> {
  const lines = [
    `set outFile to (POSIX file "${out}")`,
    "try",
    "  set imgData to (the clipboard as «class PNGf»)",
    "on error",
    '  return "none"',
    "end try",
    "set fh to open for access outFile with write permission",
    "set eof fh to 0",
    "write imgData to fh",
    "close access fh",
    'return "ok"',
  ];
  const args = lines.flatMap((line) => ["-e", line]);
  try {
    const { stdout } = await execFileAsync("osascript", args);
    if (stdout.includes("ok") && (await hasBytes(out))) {
      await protectTempImage(out);
      return { ok: true, path: out };
    }
    return { ok: false, error: "No image on the clipboard (copy an image or take a screenshot first)." };
  } catch {
    return { ok: false, error: "Could not read the clipboard via osascript." };
  }
}

async function readMac(out: string): Promise<ClipboardImageResult> {
  // Fast path: pngpaste if it happens to be installed.
  try {
    await execFileAsync("pngpaste", [out]);
    if (await hasBytes(out)) {
      await protectTempImage(out);
      return { ok: true, path: out };
    }
  } catch {
    // not installed, or nothing on the clipboard — fall back to osascript.
  }
  return readMacViaOsascript(out);
}

async function readLinux(out: string): Promise<ClipboardImageResult> {
  // xclip first, then xsel — both can dump the image/png target to stdout.
  for (const [bin, args] of [
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ] as const) {
    try {
      const { stdout } = await execFileAsync(bin, [...args], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      const buf = stdout as unknown as Buffer;
      if (buf && buf.length > 0) {
        await fs.writeFile(out, buf, { mode: PRIVATE_IMAGE_MODE });
        await protectTempImage(out);
        return { ok: true, path: out };
      }
    } catch {
      // try the next tool
    }
  }
  return {
    ok: false,
    error: "Clipboard image requires xclip or xsel (install with: sudo apt install xclip).",
  };
}

async function readWindows(out: string): Promise<ClipboardImageResult> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms;" +
    "$img=[System.Windows.Forms.Clipboard]::GetImage();" +
    `if($img -ne $null){$img.Save('${out.replace(/\\/g, "\\\\")}');Write-Output 'ok'}else{Write-Output 'none'}`;
  try {
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
    if (stdout.includes("ok") && (await hasBytes(out))) {
      await protectTempImage(out);
      return { ok: true, path: out };
    }
    return { ok: false, error: "No image found on the clipboard." };
  } catch {
    return { ok: false, error: "Failed to read the clipboard via PowerShell." };
  }
}

/**
 * Grab a clipboard image (if any) and write it to a temp PNG. Returns the
 * path on success, or a human-readable reason it couldn't.
 */
export async function readClipboardImage(): Promise<ClipboardImageResult> {
  const out = tempImagePath();
  switch (process.platform) {
    case "darwin":
      return readMac(out);
    case "linux":
      return readLinux(out);
    case "win32":
      return readWindows(out);
    default:
      return { ok: false, error: `Clipboard image not supported on ${process.platform}.` };
  }
}

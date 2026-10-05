import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedImage } from "../../shared/contract";

/**
 * Let the user pick a screen region and return it as PNG; null when cancelled.
 * macOS only: `screencapture -i` brings the system selection UI and its permission prompt.
 */
export async function captureScreenRegion(): Promise<CapturedImage | null> {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(join(tmpdir(), "easy-agent-capture-"));
  const file = join(dir, "capture.png");
  try {
    await new Promise<void>((resolve) => execFile("screencapture", ["-i", "-x", file], () => resolve()));
    const data = await readFile(file).catch(() => null);
    return data && data.length > 0 ? { data: data.toString("base64"), mimeType: "image/png" } : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

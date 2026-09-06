/**
 * Shared image helpers for multimodal input.
 *
 * Both the `Read` tool (reading an image file) and the user-input path
 * (`@image.png` references, clipboard screenshots) funnel through here so
 * the supported formats, media-type mapping, and size guard stay in one
 * place. We deliberately do NOT resize/transcode (no native image deps):
 * an image that exceeds the API's per-image limit is rejected with a clear
 * message rather than silently downscaled.
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ImageBlock } from "../types/message.js";

/** Supported image extensions → their IANA media type. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Anthropic rejects images whose base64 payload exceeds ~5 MB. base64 inflates
 * the raw bytes by ~4/3, so we cap the raw file at 3.75 MB to stay safely under
 * the encoded limit. Shared across providers as a conservative common bound.
 */
export const MAX_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);

/** The media type for a path's extension, or null if it isn't a known image. */
export function imageMediaType(filePath: string): string | null {
  return IMAGE_MEDIA_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

/** Whether the path looks like a supported image (by extension). */
export function isImagePath(filePath: string): boolean {
  return imageMediaType(filePath) !== null;
}

/**
 * Recover an image file path from pasted terminal text.
 *
 * On macOS, Cmd+V is swallowed by the terminal for "paste"; when the user
 * copied an image *file* (Finder Cmd+C), the terminal pastes its path. That
 * arrives here possibly quoted, shell-escaped (`\ `), or as a `file://` URL.
 * We normalise it and only accept a single existing image file — so typing a
 * relative path or pasting prose is never hijacked.
 *
 * Returns the cleaned absolute-ish path, or null when it isn't a lone image.
 */
export function parsePastedImagePath(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.includes("\n")) return null;

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(s.slice("file://".length));
    } catch {
      s = s.slice("file://".length);
    }
  }
  s = s.replace(/\\ /g, " ").trim();

  if (!isImagePath(s)) return null;
  // Require the file to actually exist so we don't convert half-typed paths.
  if (!existsSync(s)) return null;
  return s;
}

export type ReadImageResult =
  | { ok: true; block: ImageBlock; bytes: number; mediaType: string }
  | { ok: false; error: string };

export function imageBufferAsBlock(absPath: string, data: Buffer): ReadImageResult {
  const mediaType = imageMediaType(absPath);
  if (!mediaType) {
    return { ok: false, error: `Unsupported image type: ${path.extname(absPath) || "(none)"}` };
  }

  const bytes = data.byteLength;
  if (bytes > MAX_IMAGE_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const limit = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(2);
    return {
      ok: false,
      error: `Image too large (${mb} MB > ${limit} MB limit). Resize or compress it before sending.`,
    };
  }

  return {
    ok: true,
    bytes,
    mediaType,
    block: {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: data.toString("base64") },
    },
  };
}

/**
 * Read an image file into a base64 `ImageBlock`, enforcing the size guard.
 * The caller is expected to have already resolved/validated the path.
 */
export async function readImageAsBlock(absPath: string): Promise<ReadImageResult> {
  const mediaType = imageMediaType(absPath);
  if (!mediaType) {
    return { ok: false, error: `Unsupported image type: ${path.extname(absPath) || "(none)"}` };
  }

  let bytes: number;
  try {
    const stat = await fs.stat(absPath);
    bytes = stat.size;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: false, error: `Image not found: ${absPath}` };
    return { ok: false, error: `Cannot read image: ${err.message}` };
  }

  if (bytes > MAX_IMAGE_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const limit = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(2);
    return {
      ok: false,
      error: `Image too large (${mb} MB > ${limit} MB limit). Resize or compress it before sending.`,
    };
  }

  const data = await fs.readFile(absPath);
  return imageBufferAsBlock(absPath, data);
}

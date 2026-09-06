/**
 * Turn a plain user prompt into multimodal content when it references image
 * files via `@path` tokens. The typed text is preserved verbatim (the
 * `@path` reference stays in it so the model has context); any referenced
 * images are appended as image blocks the model can actually see.
 *
 * Non-image `@` references (source files, directories) are left untouched —
 * those are handled elsewhere as plain text mentions.
 */

import type { ContentBlock } from "../types/message.js";
import { imageBufferAsBlock, isImagePath } from "../tools/imageUtils.js";
import { readWorkspaceFile } from "../tools/pathUtils.js";
import { IMAGE_REF_RE, consumePastedImage } from "./pastedImages.js";

export interface BuiltUserContent {
  /** Plain string when no images were attached; a block array otherwise. */
  content: string | ContentBlock[];
  /** Successfully attached images (for UI / logging). */
  attached: Array<{ ref: string; bytes: number; mediaType: string }>;
  /** Human-readable reasons an `@image` reference could not be attached. */
  errors: string[];
}

const IMAGE_TOKEN_RE = /@(\S+)/g;

/** Strip trailing punctuation that commonly follows an inline @reference. */
function cleanToken(raw: string): string {
  return raw.replace(/[)\].,;:!?]+$/, "");
}

export async function buildUserMessageContent(
  prompt: string,
  cwd: string,
): Promise<BuiltUserContent> {
  const candidates = new Set<string>();
  for (const match of prompt.matchAll(IMAGE_TOKEN_RE)) {
    const ref = cleanToken(match[1] ?? "");
    if (ref && isImagePath(ref)) candidates.add(ref);
  }

  // Pasted / clipboard images referenced by their `[Image #N]` chip. The bytes
  // live in the in-memory registry (never on the @path / allowed-roots path).
  const pastedIds = new Set<number>();
  for (const match of prompt.matchAll(IMAGE_REF_RE)) {
    pastedIds.add(Number(match[1]));
  }

  if (candidates.size === 0 && pastedIds.size === 0) {
    return { content: prompt, attached: [], errors: [] };
  }

  const blocks: ContentBlock[] = [{ type: "text", text: prompt }];
  const attached: BuiltUserContent["attached"] = [];
  const errors: string[] = [];

  for (const id of pastedIds) {
    const img = consumePastedImage(id);
    if (img) {
      blocks.push(img.block);
      attached.push({ ref: `[Image #${id}]`, bytes: img.bytes, mediaType: img.mediaType });
    } else {
      errors.push(`[Image #${id}]: paste is no longer available`);
    }
  }

  for (const ref of candidates) {
    try {
      const file = await readWorkspaceFile(ref, cwd);
      const img = imageBufferAsBlock(file.requestedPath, file.data);
      if (img.ok) {
        blocks.push(img.block);
        attached.push({ ref, bytes: img.bytes, mediaType: img.mediaType });
      } else {
        errors.push(`${ref}: ${img.error}`);
      }
    } catch (error: unknown) {
      errors.push(`${ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // No image actually loaded — keep the message a plain string.
  if (attached.length === 0) {
    return { content: prompt, attached, errors };
  }

  return { content: blocks, attached, errors };
}

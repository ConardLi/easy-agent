/**
 * In-memory registry for pasted / clipboard images.
 *
 * A pasted image never travels through the filesystem + `Read` tool the way a
 * typed `@image.png` reference does — a clipboard screenshot lives in a temp
 * dir outside the workspace roots, and surfacing a raw `/var/folders/...` path
 * in the prompt is both ugly and unreadable. Instead we keep the decoded
 * base64 here, drop a compact `[Image #N]` chip into the input, and expand that
 * chip into a real image block at submit time (see `buildUserMessageContent`).
 *
 * The editor holds short placeholders; the bytes ride alongside out of band.
 */

import type { ImageBlock } from "../types/message.js";

export interface PastedImage {
  block: ImageBlock;
  mediaType: string;
  bytes: number;
  filename: string;
}

const store = new Map<number, PastedImage>();
let counter = 0;

/** Stash an image and return its placeholder id. */
export function addPastedImage(img: PastedImage): number {
  const id = ++counter;
  store.set(id, img);
  return id;
}

/** Read a stashed image and remove it (consumed at message-build time). */
export function consumePastedImage(id: number): PastedImage | undefined {
  const img = store.get(id);
  if (img) store.delete(id);
  return img;
}

/** The chip shown in the editor for a stashed image. */
export function imageRefToken(id: number): string {
  return `[Image #${id}]`;
}

/** Matches the chips so they can be located in submitted text. */
export const IMAGE_REF_RE = /\[Image #(\d+)\]/g;

/**
 * Step 32 - Multimodal input
 *
 * Goal:
 * - represent images as first-class content blocks
 * - pass image blocks through tools, compaction, UI previews, and providers
 * - attach local @image paths and clipboard screenshots to a user prompt
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// -----------------------------------------------------------------------------
// 1. Content blocks
// -----------------------------------------------------------------------------

export function textBlock(text) {
  return { type: "text", text: String(text ?? "") };
}

export function imageBlock({ data, mediaType, name }) {
  if (!data) throw new Error("image data is required");
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType || "image/png", data },
    name,
  };
}

export function normalizeContent(content) {
  if (Array.isArray(content)) return content;
  return [textBlock(content)];
}

export function toolResultContent(result) {
  if (Array.isArray(result.content)) return result.content;
  return [textBlock(result.content ?? "")];
}

// -----------------------------------------------------------------------------
// 2. Reading and attaching images
// -----------------------------------------------------------------------------

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function isImagePath(filePath) {
  return IMAGE_TYPES.has(path.extname(filePath).toLowerCase());
}

export function mediaTypeForPath(filePath) {
  return IMAGE_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

export async function readImageAsBlock(filePath, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (!isImagePath(filePath)) throw new Error(`not an image: ${filePath}`);

  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) throw new Error(`image is too large: ${stat.size} bytes`);

  return imageBlock({
    data: (await fs.readFile(filePath)).toString("base64"),
    mediaType: mediaTypeForPath(filePath),
    name: path.basename(filePath),
  });
}

export function extractImageRefs(prompt) {
  const refs = [];
  const next = String(prompt).replace(/(^|\s)@([^\s]+\.(?:png|jpe?g|gif|webp))/gi, (match, prefix, filePath) => {
    refs.push(filePath);
    return prefix.trimEnd();
  });
  return { prompt: next.trim(), refs };
}

export async function attachImagesToPrompt({ cwd, prompt, readImage = readImageAsBlock }) {
  const parsed = extractImageRefs(prompt);
  const blocks = [textBlock(parsed.prompt)];

  for (const ref of parsed.refs) {
    const filePath = path.resolve(cwd, ref);
    blocks.push(await readImage(filePath));
  }

  return blocks;
}

export async function attachClipboardImage({ prompt, clipboard }) {
  const image = await clipboard?.readImage?.();
  if (!image) return normalizeContent(prompt);
  return [textBlock(prompt), imageBlock(image)];
}

// -----------------------------------------------------------------------------
// 3. Provider request conversion
// -----------------------------------------------------------------------------

export function toAnthropicContent(content) {
  return normalizeContent(content).map((block) => {
    if (block.type === "image") return { type: "image", source: block.source };
    return { type: "text", text: block.text };
  });
}

export function toOpenAIContent(content) {
  return normalizeContent(content).map((block) => {
    if (block.type !== "image") return { type: "text", text: block.text };
    const { media_type, data } = block.source;
    return { type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } };
  });
}

export function toGeminiContent(content) {
  return normalizeContent(content).map((block) => {
    if (block.type !== "image") return { text: block.text };
    return { inline_data: { mime_type: block.source.media_type, data: block.source.data } };
  });
}

export function convertUserMessageForProvider(message, protocol) {
  if (protocol === "openai-chat") return { role: "user", content: toOpenAIContent(message.content) };
  if (protocol === "gemini") return { role: "user", parts: toGeminiContent(message.content) };
  return { role: "user", content: toAnthropicContent(message.content) };
}

// -----------------------------------------------------------------------------
// 4. Compaction and UI preview
// -----------------------------------------------------------------------------

export function compactContentBlocks(content) {
  return normalizeContent(content)
    .map((block) => (block.type === "image" ? `[image: ${block.source.media_type}]` : block.text))
    .join("\n");
}

export function renderMessagePreview(content) {
  const blocks = normalizeContent(content);
  const images = blocks.filter((block) => block.type === "image").length;
  const text = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").trim();
  return images ? `${text} [${images} image${images === 1 ? "" : "s"}]`.trim() : text;
}

// -----------------------------------------------------------------------------
// 5. Demo
// -----------------------------------------------------------------------------

export async function demoStep32() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step32-"));
  const imagePath = path.join(dir, "screen.png");
  await fs.writeFile(imagePath, Buffer.from("89504e470d0a1a0a", "hex"));

  const content = await attachImagesToPrompt({
    cwd: dir,
    prompt: "What is wrong in @screen.png?",
  });

  const clipboardContent = await attachClipboardImage({
    prompt: "Compare with clipboard",
    clipboard: {
      async readImage() {
        return { mediaType: "image/png", data: "Y2xpcGJvYXJk", name: "clipboard.png" };
      },
    },
  });

  return {
    blocks: content.length,
    preview: renderMessagePreview(content),
    compacted: compactContentBlocks(content),
    anthropicType: convertUserMessageForProvider({ content }, "anthropic").content[1].type,
    openAIType: convertUserMessageForProvider({ content }, "openai-chat").content[1].type,
    geminiType: Object.keys(convertUserMessageForProvider({ content }, "gemini").parts[1])[0],
    clipboardPreview: renderMessagePreview(clipboardContent),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  demoStep32().then((result) => console.log(JSON.stringify(result, null, 2)));
}

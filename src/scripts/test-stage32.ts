#!/usr/bin/env tsx
/**
 * Stage 32 verification — multimodal image input (no real API keys needed).
 *
 * Coverage:
 *   [1] imageUtils — extension/media-type detection + size guard
 *   [2] Read tool — reads an image file into a base64 ImageBlock
 *   [3] buildUserMessageContent — `@image` → text + image blocks; non-image
 *       and missing references degrade to a plain string
 *   [4] Provider translation — a user image block becomes OpenAI `image_url`,
 *       Responses `input_image`, and Gemini `inlineData`; tool-result images
 *       degrade to `[image]` on the non-Anthropic paths
 *   [5] Compaction — historical user images collapse to `[image]`
 *   [6] UI flatten — an image-attachment user turn renders (isn't dropped)
 *
 * Run: npm run test:stage32   (or: npx tsx src/scripts/test-stage32.ts)
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  imageMediaType,
  isImagePath,
  readImageAsBlock,
  MAX_IMAGE_BYTES,
} from "../tools/imageUtils.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { buildUserMessageContent } from "../core/attachImages.js";
import { microCompactMessages } from "../context/compaction.js";
import { toolResultText } from "../tools/Tool.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${label}`);
  } else {
    fail++;
    console.error(`  \u2717 ${label}`);
  }
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const BANNER = path.resolve(process.cwd(), "public/img/banner.jpeg");

async function main(): Promise<void> {
  // ── [1] imageUtils ────────────────────────────────────────────────────────
  section("[1] imageUtils: detection + size guard");
  assert(imageMediaType("a.png") === "image/png", ".png → image/png");
  assert(imageMediaType("a.JPG") === "image/jpeg", ".JPG (case-insensitive) → image/jpeg");
  assert(imageMediaType("a.webp") === "image/webp", ".webp → image/webp");
  assert(imageMediaType("a.ts") === null, ".ts is not an image");
  assert(isImagePath("dir/photo.jpeg") && !isImagePath("dir/code.ts"), "isImagePath discriminates");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ea-s32-"));
  const big = path.join(tmp, "big.png");
  await fs.writeFile(big, Buffer.alloc(MAX_IMAGE_BYTES + 1024));
  const bigRes = await readImageAsBlock(big);
  assert(!bigRes.ok && /too large/i.test((bigRes as { error: string }).error), "oversized image rejected by guard");
  const bigRead = await fileReadTool.call({ file_path: big }, { cwd: tmp });
  assert(
    bigRead.isError === true && /too large/i.test(toolResultText(bigRead.content)),
    "Read rejects an oversized image before producing an image block",
  );
  const bigAttachment = await buildUserMessageContent(`look at @${big}`, tmp);
  assert(
    typeof bigAttachment.content === "string" &&
      bigAttachment.errors.some((error) => /too large/i.test(error)),
    "@image rejects an oversized image without attaching it",
  );

  // ── [2] Read tool reads an image into an ImageBlock ───────────────────────
  section("[2] Read tool → ImageBlock");
  const read = await fileReadTool.call({ file_path: "public/img/banner.jpeg" }, { cwd: process.cwd() });
  assert(!read.isError, "Read on banner.jpeg succeeds");
  assert(Array.isArray(read.content), "Read returns content blocks (array)");
  if (Array.isArray(read.content)) {
    const imageBlock = read.content.find((b) => b.type === "image") as
      | { type: "image"; source: { type: string; media_type?: string; data?: string } }
      | undefined;
    assert(!!imageBlock, "Read content includes an image block");
    assert(imageBlock?.source.type === "base64", "image block uses a base64 source");
    assert(imageBlock?.source.media_type === "image/jpeg", "media_type is image/jpeg");
    assert((imageBlock?.source.data?.length ?? 0) > 1000, "base64 payload is non-trivial");
    assert(toolResultText(read.content).includes("[image]"), "toolResultText flattens image → [image]");
  }

  // ── [3] buildUserMessageContent ───────────────────────────────────────────
  section("[3] buildUserMessageContent: @image attachment");
  const withImg = await buildUserMessageContent("describe @public/img/banner.jpeg please", process.cwd());
  assert(Array.isArray(withImg.content), "@image prompt → block array");
  assert(withImg.attached.length === 1, "exactly one image attached");
  if (Array.isArray(withImg.content)) {
    const text = withImg.content.find((b) => b.type === "text") as { text?: string } | undefined;
    assert(text?.text?.includes("@public/img/banner.jpeg") === true, "original prompt text preserved verbatim");
    assert(withImg.content.some((b) => b.type === "image"), "image block appended");
  }

  const noImg = await buildUserMessageContent("just edit @src/index.ts thanks", process.cwd());
  assert(typeof noImg.content === "string", "non-image @ref stays a plain string");

  const missing = await buildUserMessageContent("look at @does-not-exist.png", process.cwd());
  assert(typeof missing.content === "string", "missing image → plain string (no crash)");
  assert(missing.errors.length === 1, "missing image surfaces one error");
  assert(missing.errors[0]?.includes("Image not found:") === true, "missing image keeps its user-facing error text");

  // Pasted / clipboard image: `[Image #N]` chip resolves from the in-memory
  // registry (no filesystem path, no allowed-roots check).
  const { addPastedImage, imageRefToken } = await import("../core/pastedImages.js");
  const pastedId = addPastedImage({
    block: { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    mediaType: "image/png",
    bytes: 3,
    filename: "Pasted image",
  });
  const pasted = await buildUserMessageContent(`describe ${imageRefToken(pastedId)} please`, process.cwd());
  assert(Array.isArray(pasted.content), "[Image #N] chip → block array");
  assert(pasted.attached.length === 1, "pasted chip attaches exactly one image");
  if (Array.isArray(pasted.content)) {
    assert(pasted.content.some((b) => b.type === "image"), "pasted image block appended from registry");
  }
  const reusedAfterConsume = await buildUserMessageContent(`again ${imageRefToken(pastedId)}`, process.cwd());
  assert(typeof reusedAfterConsume.content === "string", "chip is consumed once (no double-send)");

  // ── [4] Provider translation ──────────────────────────────────────────────
  section("[4] Provider translation: user image → image_url / input_image / inlineData");

  const { streamViaProvider } = await import("../services/api/providers/providerStream.js");
  const originalFetch = globalThis.fetch;

  function captureFetch(streamChunk: string): { body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(sseStream([streamChunk]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    return { body: () => captured };
  }
  async function drain(profile: Record<string, unknown>, messages: unknown[]): Promise<void> {
    const gen = streamViaProvider(profile as never, { messages, model: String(profile.id) } as never);
    let n = await gen.next();
    while (!n.done) n = await gen.next();
  }

  const userImageMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" } },
      ],
    },
  ];

  try {
    // openai-chat
    let cap = captureFetch(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n` + `data: [DONE]\n\n`);
    await drain({ id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" }, userImageMessages);
    const chatMsgs = cap.body().messages as Array<Record<string, unknown>>;
    const chatUser = chatMsgs.find((m) => m.role === "user");
    const chatParts = (chatUser?.content as Array<Record<string, unknown>>) ?? [];
    const chatImg = chatParts.find((p) => p.type === "image_url") as
      | { image_url?: { url?: string } }
      | undefined;
    assert(Array.isArray(chatUser?.content), "openai-chat: user content is a parts array");
    assert(
      chatImg?.image_url?.url?.startsWith("data:image/jpeg;base64,") === true,
      "openai-chat: image becomes a data: image_url",
    );

    // openai-responses
    cap = captureFetch(`data: [DONE]\n\n`);
    await drain({ id: "gpt5r", protocol: "openai-responses", model: "gpt-5.1", apiKey: "x" }, userImageMessages);
    const respInput = cap.body().input as Array<Record<string, unknown>>;
    const respUser = respInput.find((i) => i.role === "user");
    const respParts = (respUser?.content as Array<Record<string, unknown>>) ?? [];
    assert(
      respParts.some((p) => p.type === "input_image" && typeof p.image_url === "string"),
      "openai-responses: image becomes an input_image item",
    );

    // gemini
    cap = captureFetch(`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n`);
    await drain({ id: "gemini", protocol: "gemini", model: "gemini-3.5-flash", apiKey: "x" }, userImageMessages);
    const contents = cap.body().contents as Array<Record<string, unknown>>;
    const geminiParts = contents.flatMap((c) => (c.parts as Array<Record<string, unknown>>) ?? []);
    const inline = geminiParts.find((p) => p.inlineData) as { inlineData?: { mimeType?: string; data?: string } } | undefined;
    assert(inline?.inlineData?.mimeType === "image/jpeg", "gemini: image becomes inlineData with mimeType");
    assert((inline?.inlineData?.data?.length ?? 0) > 0, "gemini: inlineData carries base64 bytes");

    // tool-result image degradation (OpenAI tool role can't carry images)
    const toolImageHistory = [
      { role: "user", content: "read the image" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.png" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "Read image x.png" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
            ],
          },
        ],
      },
    ];
    cap = captureFetch(`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n` + `data: [DONE]\n\n`);
    await drain({ id: "gpt5", protocol: "openai-chat", model: "gpt-5.1", apiKey: "x" }, toolImageHistory);
    const histMsgs = cap.body().messages as Array<Record<string, unknown>>;
    const toolMsg = histMsgs.find((m) => m.role === "tool");
    assert(
      typeof toolMsg?.content === "string" && (toolMsg.content as string).includes("[image]"),
      "openai-chat: tool-result image degrades to [image] text",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  // ── [5] Compaction degrades historical user images ────────────────────────
  section("[5] Compaction: old user image → [image]");
  const history: unknown[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "old screenshot" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      ],
    },
  ];
  for (let i = 0; i < 11; i++) {
    history.push({ role: i % 2 === 0 ? "assistant" : "user", content: `filler ${i}` });
  }
  const { messages: compacted } = microCompactMessages(history as never);
  const firstContent = (compacted[0] as { content: Array<{ type: string; text?: string }> }).content;
  assert(
    Array.isArray(firstContent) && firstContent.every((b) => b.type !== "image"),
    "no image blocks remain in the old message",
  );
  assert(
    Array.isArray(firstContent) && firstContent.some((b) => b.type === "text" && b.text === "[image]"),
    "old image replaced with a [image] text marker",
  );

  // ── [6] UI flatten renders an image-attachment turn ───────────────────────
  section("[6] UI: image-attachment user turn is rendered");
  const { flattenConversation } = await import("../ui/components/ConversationView.js");
  const items = flattenConversation(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    ] as never,
  );
  assert(items.length === 1 && items[0]!.key === "u0", "image-attachment user message yields a render item");

  await fs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "\u2705" : "\u274c"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

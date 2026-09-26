import { createHash } from "node:crypto";
import type { ContentBlock } from "../../types/message.js";
import type { ToolResult } from "../../tools/Tool.js";
import { MAX_IMAGE_BYTES } from "../../tools/imageUtils.js";
import { getEasyAgentPath } from "../../utils/paths.js";
import { writePrivateFile } from "../../utils/privateData.js";

const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
};

export interface StoredMcpArtifact {
  filePath: string;
  bytes: number;
  mimeType: string;
}

function decodeMcpBase64(data: string, maxBytes: number): Buffer {
  const encoded = data.replace(/\s/g, "");
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new Error(`MCP binary content exceeds ${maxBytes} bytes`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("MCP binary content is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxBytes) throw new Error(`MCP binary content exceeds ${maxBytes} bytes`);
  return bytes;
}

export async function storeMcpArtifact(data: string, mimeType: string): Promise<StoredMcpArtifact> {
  const bytes = decodeMcpBase64(data, MAX_ARTIFACT_BYTES);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ext = EXTENSIONS[mimeType.toLowerCase()] ?? ".bin";
  const filePath = getEasyAgentPath("mcp", "artifacts", `${digest}${ext}`);
  await writePrivateFile(filePath, bytes);
  return { filePath, bytes: bytes.length, mimeType };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function describeResource(uri: string, mimeType: string | undefined): string {
  return `MCP resource ${uri}${mimeType ? ` (${mimeType})` : ""}`;
}

export async function adaptMcpToolResult(raw: Record<string, unknown>): Promise<ToolResult> {
  if (!Array.isArray(raw.content)) throw new Error("MCP tool result content must be an array");
  const content: ContentBlock[] = [];
  for (const item of raw.content) {
    const block = asRecord(item);
    if (!block || typeof block.type !== "string") throw new Error("Invalid MCP content block");
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      const mimeType = block.mimeType.toLowerCase();
      const approxBytes = Math.floor(block.data.length * 3 / 4);
      if (IMAGE_MIME_TYPES.has(mimeType) && approxBytes <= MAX_IMAGE_BYTES) {
        const bytes = decodeMcpBase64(block.data, MAX_IMAGE_BYTES);
        content.push({ type: "image", source: { type: "base64", media_type: mimeType, data: bytes.toString("base64") } });
      } else {
        const stored = await storeMcpArtifact(block.data, mimeType);
        content.push({ type: "text", text: `MCP image saved to ${stored.filePath} (${stored.mimeType}, ${stored.bytes} bytes)` });
      }
      continue;
    }
    if (block.type === "resource") {
      const resource = asRecord(block.resource);
      const uri = typeof resource?.uri === "string" ? resource.uri : "<unknown>";
      const mimeType = typeof resource?.mimeType === "string" ? resource.mimeType : undefined;
      if (typeof resource?.text === "string") {
        content.push({ type: "text", text: resource.text });
      } else if (typeof resource?.blob === "string") {
        const stored = await storeMcpArtifact(resource.blob, mimeType ?? "application/octet-stream");
        content.push({ type: "text", text: `${describeResource(uri, mimeType)} saved to ${stored.filePath} (${stored.bytes} bytes)` });
      } else {
        content.push({ type: "text", text: JSON.stringify(block) });
      }
      continue;
    }
    if (block.type === "audio" && typeof block.data === "string") {
      const stored = await storeMcpArtifact(block.data, typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream");
      content.push({ type: "text", text: `MCP audio saved to ${stored.filePath} (${stored.mimeType}, ${stored.bytes} bytes)` });
      continue;
    }
    content.push({ type: "text", text: JSON.stringify(block) });
  }
  if (raw.structuredContent !== undefined) {
    content.push({ type: "text", text: `MCP structured content:\n${JSON.stringify(raw.structuredContent, null, 2)}` });
  }
  return {
    content: content.every((block) => block.type === "text") && raw.structuredContent === undefined
      ? content.map((block) => block.type === "text" ? block.text : "").join("\n")
      : content,
    isError: raw.isError === true,
    mcpResult: raw,
  };
}

export async function adaptMcpResourceResult(raw: Record<string, unknown>): Promise<ToolResult> {
  if (!Array.isArray(raw.contents)) throw new Error("MCP resource result contents must be an array");
  const contents: Array<Record<string, unknown>> = [];
  for (const item of raw.contents) {
    const resource = asRecord(item);
    if (!resource || typeof resource.uri !== "string") throw new Error("Invalid MCP resource content");
    if (typeof resource.blob === "string") {
      const stored = await storeMcpArtifact(resource.blob, typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream");
      contents.push({ uri: resource.uri, mimeType: stored.mimeType, filePath: stored.filePath, bytes: stored.bytes });
    } else {
      contents.push(resource);
    }
  }
  return { content: JSON.stringify({ contents }, null, 2), mcpResult: raw };
}

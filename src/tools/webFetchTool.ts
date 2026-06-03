import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { createMessage } from "../services/api/streaming.js";
import { debugLog } from "../utils/log.js";
import {
  fetchUrlContent,
  MAX_MARKDOWN_LENGTH,
  type FetchedContent,
} from "./webFetch/fetcher.js";
import { isPreapprovedUrl } from "./webFetch/preapproved.js";
import { validateFetchUrl } from "./webFetch/urlValidation.js";

/**
 * WebFetch — fetch a URL, convert it to markdown, and run the model's prompt
 * over the content to extract just what's relevant.
 *
 * Reference: claude-code-source-code/src/tools/WebFetchTool/WebFetchTool.ts.
 * Two-stage design (mirrors the source): fetch + convert, then a secondary
 * model pass that applies `prompt` to the fetched markdown. Preapproved
 * documentation hosts skip the confirmation prompt; everything else is gated
 * per-domain by the permission system (see permissions.ts WebFetch branch).
 *
 * Permission note: this tool is read-only (usable in plan mode), but its
 * domain-permission decision is handled specially in checkPermission so that
 * read-only status does NOT auto-allow arbitrary domains.
 */
interface WebFetchInput {
  url: string;
  prompt: string;
}

const EXTRACT_MAX_TOKENS = 2048;

function truncate(text: string): string {
  if (text.length <= MAX_MARKDOWN_LENGTH) return text;
  return `${text.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length…]`;
}

/**
 * Apply the user's prompt to the fetched markdown via a secondary model call
 * (the user's active model, so provider auth always matches). Falls back to
 * returning the truncated raw content if the model call fails — WebFetch still
 * yields useful content rather than erroring out.
 */
async function applyPromptToContent(
  prompt: string,
  content: string,
  model: string | undefined,
): Promise<string> {
  const truncated = truncate(content);
  const userPrompt =
    `Here is the content of a web page (converted to markdown):\n\n` +
    `<web_page_content>\n${truncated}\n</web_page_content>\n\n` +
    `Based on the web page content above, respond to this request:\n${prompt}`;

  try {
    const response = await createMessage({
      model,
      maxTokens: EXTRACT_MAX_TOKENS,
      messages: [{ role: "user", content: userPrompt }],
      querySource: "background",
    });
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  } catch (error) {
    debugLog("webFetch", "secondary-model-failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // Degrade: hand the raw (truncated) content to the main model.
  return `[Could not run the extraction prompt; returning raw page content.]\n\n${truncated}`;
}

export const webFetchTool: Tool = {
  name: "WebFetch",
  description:
    "Fetch content from a URL and extract information from it using a prompt. Converts HTML to markdown. Use for reading documentation and public web pages. WILL FAIL for authenticated/private URLs — prefer a dedicated MCP tool for those.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "The URL to fetch content from (http/https)" },
      prompt: { type: "string", description: "What to extract or answer from the fetched content" },
    },
    required: ["url", "prompt"],
  },
  maxResultSizeChars: 100_000,
  async call(rawInput: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = rawInput as unknown as WebFetchInput;
    if (!input.url || typeof input.url !== "string") {
      return { content: "Error: url is required", isError: true };
    }
    if (!input.prompt || typeof input.prompt !== "string") {
      return { content: "Error: prompt is required", isError: true };
    }

    const validation = validateFetchUrl(input.url);
    if (!validation.ok) {
      return { content: `Error: ${validation.reason}`, isError: true };
    }

    let fetched;
    try {
      fetched = await fetchUrlContent(input.url, context.abortSignal);
    } catch (error) {
      return {
        content: `Error fetching ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }

    if (fetched.type === "redirect") {
      return {
        content:
          `REDIRECT DETECTED: ${input.url} redirects to a different host.\n` +
          `Redirect URL: ${fetched.redirectUrl}\n` +
          `Status: ${fetched.statusCode}\n\n` +
          `To continue, call WebFetch again with url="${fetched.redirectUrl}" and the same prompt.`,
      };
    }

    const page = fetched as FetchedContent;
    const isPreapproved = isPreapprovedUrl(input.url);

    // Preapproved docs returning short markdown are passed through verbatim;
    // everything else goes through the extraction model pass.
    let result: string;
    if (isPreapproved && page.contentType.includes("markdown") && page.content.length < MAX_MARKDOWN_LENGTH) {
      result = page.content;
    } else {
      result = await applyPromptToContent(input.prompt, page.content, context.defaultModel);
    }

    const header = `Fetched ${input.url} (${page.status} ${page.statusText}, ${page.bytes} bytes${
      page.converted ? ", html→markdown" : ""
    })`;
    return { content: `${header}\n\n${result}` };
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  // Intentionally NOT concurrency-safe (diverges from source). WebFetch may
  // trigger a per-domain "ask" prompt, and Easy Agent's permission UI is
  // single-flight — two concurrent prompts would clobber each other's resolver
  // and deadlock the turn. Serializing WebFetch lets prompts happen one at a
  // time; once a domain is approved with "always", later same-domain fetches
  // skip the prompt anyway.
  isConcurrencySafe(): boolean {
    return false;
  },
};

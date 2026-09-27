import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import type { Tool } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";
import { findLspServer, getLspStatus } from "../services/lsp/runtime.js";

const methods: Record<string, string> = {
  definition: "textDocument/definition", references: "textDocument/references",
  hover: "textDocument/hover", documentSymbol: "textDocument/documentSymbol",
};
export const lspTool: Tool = {
  name: "LSP", searchHint: "code definitions references hover symbols", shouldDefer: true,
  description: "Query a configured language server for definitions, references, hover information or document symbols. Line and character are zero-based UTF-16 positions.",
  inputSchema: { type: "object", properties: {
    operation: { type: "string", enum: Object.keys(methods) },
    file_path: { type: "string", minLength: 1 },
    line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 },
  }, required: ["operation", "file_path"], additionalProperties: false },
  isEnabled: () => getLspStatus().some((server) => server.status === "ready"),
  isReadOnly: () => true,
  async call(input, context) {
    try {
      const file = await resolveWorkspacePath(String(input.file_path), context.cwd);
      const entry = findLspServer(file);
      if (!entry) return { content: "No active language server supports this file. Configure plugin lspServers and reload the plugin.", isError: true };
      const operation = String(input.operation);
      if (!methods[operation]) throw new Error("Unsupported LSP operation");
      if (operation !== "documentSymbol" && (!Number.isInteger(input.line) || !Number.isInteger(input.character))) throw new Error("line and character are required for this operation");
      const text = await readFile(file, "utf8");
      const uri = pathToFileURL(file).href;
      await entry.client.openDocument(uri, entry.registration.config.extensionToLanguage[extname(file)]!, text);
      const result = await entry.client.request(methods[operation]!, {
        textDocument: { uri },
        ...(operation === "documentSymbol" ? {} : { position: { line: input.line, character: input.character } }),
        ...(operation === "references" ? { context: { includeDeclaration: true } } : {}),
      }, context.abortSignal);
      return { content: JSON.stringify(result ?? null) };
    } catch (error) { return { content: `LSP: ${error instanceof Error ? error.message : String(error)}`, isError: true }; }
  },
};

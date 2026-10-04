/** Two real API requests; only a local, read-only probe tool is exposed. */
import assert from "node:assert/strict";
import { config } from "dotenv";
import { createMessage } from "../services/api/streaming.js";
import { loadProfiles, resolveProfile } from "../services/api/providers/profile.js";
import { toolSearchTool } from "../tools/toolSearchTool.js";
import type { Tool } from "../tools/Tool.js";
import { prepareToolSearchRequest } from "../utils/toolSearch.js";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";

config({ quiet: true });
// Bound the entire probe, including SDK retries on unreachable gateways.
setTimeout(() => {
  console.error("ToolSearch live probe timed out after 60 seconds.");
  process.exit(1);
}, 60_000).unref();
const modelIndex = process.argv.indexOf("--model");
const model =
  (modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined) ??
  (await loadProfiles()).defaultModel ??
  process.env.ANTHROPIC_MODEL;
if (!model) throw new Error("Set ANTHROPIC_MODEL or pass --model <profile-or-model>.");
const profile = await resolveProfile(model);
const probe: Tool = {
  name: "ToolSearchProbe",
  shouldDefer: true,
  description: "Read-only local probe. Call it with marker toolsearch-live-ok.",
  inputSchema: {
    type: "object",
    properties: { marker: { type: "string", enum: ["toolsearch-live-ok"] } },
    required: ["marker"],
    additionalProperties: false,
  },
  isEnabled: () => true,
  isReadOnly: () => true,
  async call(input) {
    assert.equal(input.marker, "toolsearch-live-ok");
    return { content: "OK" };
  },
};
const tools = [toolSearchTool, probe];
const messages: MessageParam[] = [
  {
    role: "user",
    content:
      "Use ToolSearch with select:ToolSearchProbe, then call ToolSearchProbe with the marker specified by its schema.",
  },
];
const shape = () =>
  prepareToolSearchRequest({
    tools,
    messages,
    model: profile.model,
    env: { protocol: profile.protocol, baseURL: profile.baseURL ?? process.env.ANTHROPIC_BASE_URL },
  });
const first = shape();
if (!first.enabled)
  throw new Error(
    "ToolSearch is disabled for this profile. Check the model, gateway and EASY_AGENT_ENABLE_TOOL_SEARCH=true.",
  );
assert(!first.tools.some((tool) => tool.name === probe.name));
const result = await createMessage({
  model,
  messages: first.messages,
  tools: first.tools,
  toolSearchEnabled: true,
  betaHeaders: first.betaHeaders,
  maxTokens: 1024,
  toolChoice: { type: "tool", name: "ToolSearch" },
});
const search = result.content.find((block) => block.type === "tool_use");
assert(search?.type === "tool_use" && search.name === "ToolSearch", "First response must call ToolSearch");
const found = await toolSearchTool.call(search.input, { cwd: process.cwd(), availableTools: tools });
assert(!found.isError);
assert(
  Array.isArray(found.content) && found.content.some((b) => b.type === "tool_reference" && b.tool_name === probe.name),
  "Search must discover the probe",
);
messages.push(
  { role: "assistant", content: result.content as MessageParam["content"] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: search.id, content: found.content as never }] },
);
const second = shape();
assert(second.tools.some((tool) => tool.name === probe.name));
const followUp = await createMessage({
  model,
  messages: second.messages,
  tools: second.tools,
  toolSearchEnabled: true,
  betaHeaders: second.betaHeaders,
  maxTokens: 1024,
  toolChoice: { type: "tool", name: probe.name },
});
const invocation = followUp.content.find((block) => block.type === "tool_use");
assert(
  invocation?.type === "tool_use" && invocation.name === probe.name,
  "Second response must call the discovered probe",
);
await probe.call(invocation.input, { cwd: process.cwd() });
console.log(`PASS: ${profile.protocol} / ${profile.model}: ToolSearch → tool_reference → probe call`);
console.log(
  `Usage: ${result.usage.input_tokens + followUp.usage.input_tokens} input, ${result.usage.output_tokens + followUp.usage.output_tokens} output tokens`,
);

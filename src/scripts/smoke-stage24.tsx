import { renderToString } from "ink";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { flattenConversation, ConversationView } from "../ui/components/ConversationView.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "  \u2713" : "  \u2717"} ${label}`);
  if (!cond) failures++;
}

// Snapshot A: user asked, assistant replied with text + a tool_use, NO result yet.
const beforeResult: MessageParam[] = [
  { role: "user", content: "read foo.ts" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Reading the file now." },
      { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "foo.ts" } },
    ] as never,
  },
];

// Snapshot B: same, plus the tool_result committed.
const afterResult: MessageParam[] = [
  ...beforeResult,
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool_1", content: "file contents here" }] as never,
  },
];

console.log("[1] flattenConversation append-only invariant");
const itemsA = flattenConversation(beforeResult);
const itemsB = flattenConversation(afterResult);

const keysA = itemsA.map((i) => i.key);
const keysB = itemsB.map((i) => i.key);
console.log("    before:", keysA.join(", "));
console.log("    after: ", keysB.join(", "));

assert(keysA.length === 2, "before result → 2 items (user + assistant text), no tool card");
assert(!keysA.includes("tutool_1"), "tool card absent before result lands");
assert(keysB.includes("tutool_1"), "tool card present after result lands");
assert(
  keysA.every((k, i) => keysB[i] === k),
  "earlier items keep identical keys + order (append-only)",
);
assert(keysB.length === keysA.length + 1, "exactly one item appended");

console.log("\n[2] ConversationView renders without crashing");
let outputB = "";
try {
  outputB = renderToString(<ConversationView messages={afterResult} />);
  assert(true, "renderToString succeeded");
} catch (error) {
  assert(false, `renderToString threw: ${(error as Error).message}`);
}
assert(outputB.includes("read foo.ts"), "user text rendered");
assert(outputB.includes("Reading the file now."), "assistant text rendered");
assert(outputB.includes("Read"), "tool card rendered");

console.log("\n[3] empty + command-bubble cases");
assert(flattenConversation([]).length === 0, "empty messages → no items");
const cmd: MessageParam[] = [
  { role: "user", content: "<command-name>/review</command-name>\n<command-args>foo.ts</command-args>" },
];
const cmdItems = flattenConversation(cmd);
assert(cmdItems.length === 1, "command marker → one bubble item");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

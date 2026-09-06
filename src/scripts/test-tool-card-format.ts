import assert from "node:assert/strict";
import { summarizeTool } from "../ui/utils/toolCardFormat.js";

const pending = summarizeTool("Skill", {
  skill: "demo:greet",
  args: "Ada",
});
assert.deepEqual(pending, {
  label: "Skill",
  target: "demo:greet Ada",
  stat: undefined,
});

const loaded = summarizeTool(
  "Skill",
  { skill: "demo:greet", args: "Ada" },
  'Loaded skill "demo:greet" (project).\n\nFollow the instructions below.',
);
assert.deepEqual(loaded, {
  label: "Skill",
  target: "demo:greet Ada",
  stat: "loaded",
});

const failed = summarizeTool(
  "Skill",
  { skill: "missing" },
  'Skill "missing" not found.',
);
assert.deepEqual(failed, {
  label: "Skill",
  target: "missing",
  stat: undefined,
});

process.stdout.write("Skill tool-card formatting passed.\n");

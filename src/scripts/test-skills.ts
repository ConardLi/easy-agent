#!/usr/bin/env tsx
/**
 * Stage 17 verification script — exercise the Skills subsystem WITHOUT
 * touching the LLM. Lets you validate the file loader, frontmatter
 * parser, registry split (dynamic vs conditional), budget formatter,
 * conditional activation, and SkillTool execution end-to-end against
 * the example skills under `<cwd>/.easy-agent/skills/`.
 *
 * Usage:
 *   cd easy-agent
 *   npx tsx src/scripts/test-skills.ts
 *
 * Exits non-zero if any assertion fails — convenient for CI / manual checks.
 */

import { bootstrapSkills } from "../skills/bootstrap.js";
import {
  findSkill,
  getAllUserInvocableSkills,
  getModelVisibleSkills,
  listConditionalSkills,
} from "../skills/registry.js";
import { formatSkillsSystemReminder } from "../skills/budget.js";
import { activateConditionalSkillsForPaths } from "../skills/conditional.js";
import { skillTool } from "../tools/skillTool.js";
import { matchesPermissionRule } from "../permissions/permissions.js";

const cwd = process.cwd();

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

async function main(): Promise<void> {
  console.log(`\n[1] bootstrapSkills(${cwd})`);
  const result = await bootstrapSkills(cwd);
  console.log(
    `    loaded ${result.skillCount} unconditional + ${result.conditionalCount} conditional skill(s); ${result.warnings.length} warning(s).`,
  );

  console.log("\n[2] Registry split");
  const allUserInvocable = getAllUserInvocableSkills();
  const visibleToModel = getModelVisibleSkills();
  const conditional = listConditionalSkills();
  console.log(`    user-invocable: ${allUserInvocable.map((s) => s.name).join(", ")}`);
  console.log(`    model-visible:  ${visibleToModel.map((s) => s.name).join(", ")}`);
  console.log(`    conditional:    ${conditional.map((s) => s.name).join(", ")}`);

  assert(findSkill("hello-world"), "hello-world skill loaded");
  assert(findSkill("test-reviewer"), "test-reviewer skill loaded (conditional)");
  assert(findSkill("secret-handshake"), "secret-handshake skill loaded (hidden)");

  assert(
    !visibleToModel.some((s) => s.name === "secret-handshake"),
    "secret-handshake is HIDDEN from the model listing (disable-model-invocation: true)",
  );
  assert(
    !visibleToModel.some((s) => s.name === "test-reviewer"),
    "test-reviewer is HIDDEN from the initial model listing (paths gates it)",
  );
  assert(
    visibleToModel.some((s) => s.name === "hello-world"),
    "hello-world IS visible to the model",
  );

  console.log("\n[3] system-reminder formatting (initial)");
  const reminder = formatSkillsSystemReminder(visibleToModel);
  console.log(reminder.split("\n").map((l) => `    ${l}`).join("\n"));
  assert(reminder.includes("hello-world"), "system-reminder mentions hello-world");
  assert(!reminder.includes("test-reviewer"), "system-reminder does NOT mention test-reviewer initially");
  assert(!reminder.includes("secret-handshake"), "system-reminder does NOT mention secret-handshake");

  console.log("\n[4] Conditional activation via file path match");
  const activated = activateConditionalSkillsForPaths(["src/foo.test.ts"], cwd);
  console.log(`    activated: ${activated.join(", ") || "(none)"}`);
  assert(activated.includes("test-reviewer"), "test-reviewer activated by *.test.ts path");
  const reminderAfter = formatSkillsSystemReminder(getModelVisibleSkills());
  assert(reminderAfter.includes("test-reviewer"), "test-reviewer NOW appears in the system-reminder");

  console.log("\n[5] Permission rule matching");
  assert(
    matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "hello-world" }),
    "Skill(hello-world) matches exactly",
  );
  assert(
    !matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "test-reviewer" }),
    "Skill(hello-world) does NOT match test-reviewer",
  );
  assert(
    matchesPermissionRule("Skill(test-*)", "Skill", { skill: "test-reviewer" }),
    "Skill(test-*) prefix-matches test-reviewer",
  );
  assert(
    !matchesPermissionRule("Skill(test-*)", "Skill", { skill: "hello-world" }),
    "Skill(test-*) does NOT match hello-world",
  );

  console.log("\n[6] SkillTool.call() — variable substitution");
  const okResult = await skillTool.call(
    { skill: "hello-world", args: "Easy Agent" },
    { cwd, sessionId: "session-test-abc" },
  );
  console.log(okResult.content.split("\n").slice(0, 8).map((l) => `    ${l}`).join("\n"));
  assert(!okResult.isError, "Skill call succeeded");
  assert(okResult.content.includes("Easy Agent"), "$ARGUMENTS substituted with \"Easy Agent\"");
  assert(okResult.content.includes("session-test-abc"), "${CLAUDE_SESSION_ID} substituted");
  assert(
    okResult.content.includes(".easy-agent/skills/hello-world"),
    "${CLAUDE_SKILL_DIR} substituted with the absolute skill path",
  );

  console.log("\n[7] SkillTool.call() — disable-model-invocation rejected");
  const hiddenResult = await skillTool.call(
    { skill: "secret-handshake" },
    { cwd, sessionId: "x" },
  );
  console.log(`    ${hiddenResult.content.split("\n")[0]}`);
  assert(hiddenResult.isError, "Hidden skill rejected when invoked by the model");
  assert(
    hiddenResult.content.includes("disable-model-invocation"),
    "Error message mentions disable-model-invocation",
  );

  console.log("\n[8] SkillTool.call() — unknown skill rejected");
  const unknownResult = await skillTool.call(
    { skill: "does-not-exist" },
    { cwd, sessionId: "x" },
  );
  assert(unknownResult.isError, "Unknown skill name returns an error");

  console.log("\n[9] SkillTool.call() — invalid name rejected");
  const invalidNameResult = await skillTool.call(
    { skill: "../../etc/passwd" },
    { cwd, sessionId: "x" },
  );
  assert(invalidNameResult.isError, "Skill name with path traversal characters is rejected");

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log("\nAll skills checks passed.\n");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});

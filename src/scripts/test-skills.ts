#!/usr/bin/env tsx

import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import {
  clearSkills,
  findSkill,
  getAllUserInvocableSkills,
  getModelVisibleSkills,
  listConditionalSkills,
} from "../services/skills/registry.js";
import { formatSkillsSystemReminder } from "../services/skills/budget.js";
import { activateConditionalSkillsForPaths } from "../services/skills/conditional.js";
import { skillTool } from "../tools/skillTool.js";
import { toolResultText } from "../tools/Tool.js";
import { matchesPermissionRule } from "../permissions/permissions.js";

const failures: string[] = [];

function check(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

async function writeSkill(cwd: string, name: string, content: string): Promise<void> {
  const dir = path.join(cwd, ".easy-agent", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

async function createFixtures(cwd: string): Promise<void> {
  await Promise.all([
    writeSkill(
      cwd,
      "hello-world",
      [
        "---",
        "name: hello-world",
        "description: Return a deterministic greeting.",
        "allowed-tools: [Read]",
        "---",
        "",
        "Hello $ARGUMENTS",
        "Session: ${CLAUDE_SESSION_ID}",
        "Directory: ${CLAUDE_SKILL_DIR}",
      ].join("\n"),
    ),
    writeSkill(
      cwd,
      "test-reviewer",
      [
        "---",
        "name: test-reviewer",
        "description: Review test files.",
        "allowed-tools: [Read, Grep, Glob]",
        "paths:",
        '  - "**/*.test.ts"',
        '  - "**/*.spec.ts"',
        "---",
        "",
        "Review the selected test file.",
      ].join("\n"),
    ),
    writeSkill(
      cwd,
      "secret-handshake",
      [
        "---",
        "name: secret-handshake",
        "description: User-only command.",
        "disable-model-invocation: true",
        "---",
        "",
        "Return the configured response.",
      ].join("\n"),
    ),
  ]);
}

async function runChecks(cwd: string): Promise<void> {
  console.log("\n[1] Isolated skill discovery");
  const result = await bootstrapSkills(cwd);
  console.log(
    `    loaded ${result.skillCount} unconditional + ${result.conditionalCount} conditional skill(s); ${result.warnings.length} warning(s).`,
  );
  check(result.warnings.length === 0, "fixtures load without warnings");

  console.log("\n[2] Registry visibility");
  const allUserInvocable = getAllUserInvocableSkills();
  const visibleToModel = getModelVisibleSkills();
  const conditional = listConditionalSkills();
  check(allUserInvocable.length === 3, "all three skills are user-invocable");
  check(Boolean(findSkill("hello-world")), "unconditional skill is loaded");
  check(Boolean(findSkill("test-reviewer")), "conditional skill is loaded");
  check(Boolean(findSkill("secret-handshake")), "user-only skill is loaded");
  check(!visibleToModel.some((skill) => skill.name === "secret-handshake"), "user-only skill is hidden from the model");
  check(
    !visibleToModel.some((skill) => skill.name === "test-reviewer"),
    "conditional skill is initially hidden from the model",
  );
  check(
    visibleToModel.some((skill) => skill.name === "hello-world"),
    "unconditional skill is visible to the model",
  );
  check(
    conditional.some((skill) => skill.name === "test-reviewer"),
    "conditional registry is populated",
  );

  console.log("\n[3] System reminder");
  const reminder = formatSkillsSystemReminder(visibleToModel);
  check(reminder.includes("hello-world"), "visible skill appears in the reminder");
  check(!reminder.includes("test-reviewer"), "inactive conditional skill is omitted");
  check(!reminder.includes("secret-handshake"), "user-only skill is omitted");

  console.log("\n[4] Conditional activation");
  const activated = activateConditionalSkillsForPaths(["src/foo.test.ts"], cwd);
  check(activated.includes("test-reviewer"), "matching path activates the conditional skill");
  check(
    formatSkillsSystemReminder(getModelVisibleSkills()).includes("test-reviewer"),
    "activated skill appears in the reminder",
  );

  console.log("\n[5] Permission matching");
  check(matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "hello-world" }), "exact skill rule matches");
  check(
    !matchesPermissionRule("Skill(hello-world)", "Skill", { skill: "test-reviewer" }),
    "exact skill rule rejects a different skill",
  );
  check(matchesPermissionRule("Skill(test-*)", "Skill", { skill: "test-reviewer" }), "skill prefix rule matches");

  console.log("\n[6] Variable substitution");
  const sessionRules: string[] = [];
  const okResult = await skillTool.call(
    { skill: "hello-world", args: "Easy Agent" },
    {
      cwd,
      sessionId: "session-test-abc",
      addSessionAllowRules: (rules) => sessionRules.push(...rules),
    },
  );
  const okText = toolResultText(okResult.content);
  check(!okResult.isError, "skill call succeeds");
  check(okText.includes("Easy Agent"), "$ARGUMENTS is substituted");
  check(okText.includes("session-test-abc"), "session id is substituted");
  check(okText.includes(".easy-agent/skills/hello-world"), "skill directory is substituted");
  check(sessionRules.includes("Read"), "allowed tools are added to session rules");

  console.log("\n[7] Rejected invocations");
  const hiddenResult = await skillTool.call({ skill: "secret-handshake" }, { cwd, sessionId: "x" });
  check(Boolean(hiddenResult.isError), "model invocation of a user-only skill is rejected");
  check(
    toolResultText(hiddenResult.content).includes("disable-model-invocation"),
    "rejection explains the invocation policy",
  );

  const unknownResult = await skillTool.call({ skill: "does-not-exist" }, { cwd, sessionId: "x" });
  check(Boolean(unknownResult.isError), "unknown skill is rejected");

  const invalidNameResult = await skillTool.call({ skill: "../../etc/passwd" }, { cwd, sessionId: "x" });
  check(Boolean(invalidNameResult.isError), "invalid skill name is rejected");
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-skills-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    await createFixtures(cwd);
    await runChecks(cwd);
  } finally {
    clearSkills();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nAll skill checks passed.\n");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

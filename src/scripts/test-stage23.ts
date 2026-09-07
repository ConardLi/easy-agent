#!/usr/bin/env tsx
/**
 * Stage 23 verification script — exercise Output Styles + user-defined
 * Slash Commands WITHOUT touching the LLM.
 *
 * Coverage:
 *   [1]  Output style registry — built-ins, active state, resolve, config gate
 *   [2]  Output style dir loader — frontmatter, keep-coding-instructions,
 *                                   project-over-user precedence
 *   [3]  Output style bootstrap — persisted `outputStyle` is applied
 *   [4]  System prompt injection — section present + keepCodingInstructions
 *                                   drops the coding guidance
 *   [5]  Argument substitution — $ARGUMENTS / $1 / $ARGUMENTS[n] / append
 *   [6]  Command dir loader — naming, namespacing, frontmatter, precedence
 *   [7]  Settings writer — updateUserSettings round-trip
 *
 * Usage:
 *   cd easy-agent
 *   npx tsx src/scripts/test-stage23.ts
 *
 * Stubs HOME to a temp dir so anything written under ~/.easy-agent never
 * escapes the sandbox. Exits non-zero on any assertion failure.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_OUTPUT_STYLE_NAME,
  clearOutputStyles,
  getActiveOutputStyleConfig,
  getActiveOutputStyleName,
  getAllOutputStyles,
  getOutputStyle,
  resolveOutputStyle,
  setActiveOutputStyle,
  setCustomOutputStyles,
} from "../styles/registry.js";
import { loadAllOutputStyles } from "../styles/loadOutputStylesDir.js";
import { bootstrapOutputStyles } from "../styles/bootstrap.js";
import { buildSystemPrompt, renderSystemPrompt } from "../context/systemPrompt.js";
import {
  parseArguments,
  substituteArguments,
} from "../commands/userCommands/argumentSubstitution.js";
import { loadAllUserCommands } from "../commands/userCommands/loadCommandsDir.js";
import {
  clearUserCommands,
  findUserCommand,
  setUserCommands,
} from "../commands/userCommands/registry.js";
import { bootstrapUserCommands } from "../commands/userCommands/bootstrap.js";
import { updateUserSettings, readMergedStringSetting } from "../utils/settings.js";
import { trustProjectForSession } from "../config/globalState.js";

// ─── Test plumbing ──────────────────────────────────────────────────

const failures: string[] = [];
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failures.push(label);
  }
}

/**
 * Run `fn` with a temp HOME *and* a temp CWD so disk operations stay
 * sandboxed. Resets the in-memory registries afterwards so tests don't
 * leak state into each other.
 */
async function withTempEnv(
  fn: (tmpHome: string, tmpCwd: string) => Promise<void>,
): Promise<void> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "stage23-home-"));
  const tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "stage23-cwd-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  try {
    await fn(tmpHome, tmpCwd);
  } finally {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpCwd, { recursive: true, force: true });
    clearOutputStyles();
    clearUserCommands();
  }
}

async function writeFileEnsuringDir(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

async function main(): Promise<void> {
  // ─── [1] Output style registry ─────────────────────────────────
  console.log("\n[1] output style registry — built-ins, active state, resolve");

  clearOutputStyles();
  const builtins = getAllOutputStyles();
  assert(builtins.length === 3, "3 built-in styles registered");
  assert(
    builtins.map((s) => s.name).join(",") === "default,Explanatory,Learning",
    "built-in order: default, Explanatory, Learning",
  );
  assert(
    getActiveOutputStyleName() === DEFAULT_OUTPUT_STYLE_NAME,
    "active style starts as default",
  );
  assert(
    getActiveOutputStyleConfig() === null,
    "default style → getActiveOutputStyleConfig() is null (no section)",
  );

  assert(
    resolveOutputStyle("explanatory")?.name === "Explanatory",
    "resolveOutputStyle is case-insensitive",
  );
  assert(getOutputStyle("explanatory") === undefined, "getOutputStyle is case-sensitive");

  assert(setActiveOutputStyle("Explanatory") === true, "switch to Explanatory succeeds");
  assert(getActiveOutputStyleName() === "Explanatory", "active style is now Explanatory");
  assert(
    getActiveOutputStyleConfig()?.prompt.includes("Insight") === true,
    "Explanatory config carries the Insight prompt",
  );
  assert(setActiveOutputStyle("nope") === false, "switch to unknown style fails");
  assert(
    getActiveOutputStyleName() === "Explanatory",
    "failed switch leaves the active style untouched",
  );
  clearOutputStyles();

  // ─── [2] Output style dir loader ───────────────────────────────
  console.log("\n[2] output style dir loader — frontmatter + precedence");

  await withTempEnv(async (home, cwd) => {
    // user style
    await writeFileEnsuringDir(
      path.join(home, ".easy-agent", "output-styles", "Terse.md"),
      `---\nname: Terse\ndescription: Ultra short answers\nkeep-coding-instructions: false\n---\nAlways answer in one sentence.`,
    );
    // project style (same name as a user style → project wins)
    await writeFileEnsuringDir(
      path.join(cwd, ".easy-agent", "output-styles", "Terse.md"),
      `---\nname: Terse\ndescription: Project terse\n---\nProject-scoped terse prompt.`,
    );
    // project-only style, no frontmatter name → filename is the name
    await writeFileEnsuringDir(
      path.join(cwd, ".easy-agent", "output-styles", "Pirate.md"),
      `Answer like a pirate.`,
    );

    const { styles, warnings } = await loadAllOutputStyles(cwd);
    assert(warnings.length === 0, "no warnings for valid styles");
    const byName = new Map(styles.map((s) => [s.name, s]));
    assert(byName.size === 2, "Terse + Pirate loaded (Terse de-duped to one)");
    assert(
      byName.get("Terse")?.source === "project",
      "project Terse overrides user Terse",
    );
    assert(
      byName.get("Terse")?.description === "Project terse",
      "winning Terse carries project description",
    );
    assert(
      byName.get("Terse")?.keepCodingInstructions === true,
      "project Terse defaults keepCodingInstructions=true (no frontmatter flag)",
    );
    assert(byName.get("Pirate")?.name === "Pirate", "filename becomes style name");
    assert(
      byName.get("Pirate")?.prompt === "Answer like a pirate.",
      "body becomes the style prompt",
    );

    // Register them and confirm a custom keep-coding-instructions:false style
    setCustomOutputStyles([
      {
        name: "Terse",
        description: "x",
        prompt: "one sentence only",
        source: "user",
        keepCodingInstructions: false,
      },
    ]);
    assert(getAllOutputStyles().length === 4, "custom style adds to the 3 built-ins");
    assert(
      getOutputStyle("Terse")?.keepCodingInstructions === false,
      "keep-coding-instructions:false preserved through the registry",
    );
  });

  // ─── [3] Output style bootstrap — persisted preference ─────────
  console.log("\n[3] output style bootstrap — persisted `outputStyle` applied");

  await withTempEnv(async (home, cwd) => {
    await writeFileEnsuringDir(
      path.join(home, ".easy-agent", "settings.json"),
      JSON.stringify({ outputStyle: "Learning" }, null, 2),
    );
    const result = await bootstrapOutputStyles(cwd);
    assert(result.activeStyle === "Learning", "persisted outputStyle becomes active");
    assert(getActiveOutputStyleName() === "Learning", "registry active state matches");

    // Unknown persisted value falls back to default
    clearOutputStyles();
    await writeFileEnsuringDir(
      path.join(home, ".easy-agent", "settings.json"),
      JSON.stringify({ outputStyle: "Ghost" }, null, 2),
    );
    const result2 = await bootstrapOutputStyles(cwd);
    assert(
      result2.activeStyle === DEFAULT_OUTPUT_STYLE_NAME,
      "unknown persisted style → falls back to default",
    );
  });

  // ─── [4] System prompt injection ───────────────────────────────
  console.log("\n[4] system prompt — output style section + keepCodingInstructions");

  await withTempEnv(async (_home, cwd) => {
    // default → no output-style section, coding instructions present
    clearOutputStyles();
    const defaultPrompt = renderSystemPrompt(await buildSystemPrompt({ cwd }));
    assert(
      !defaultPrompt.includes("# Output Style:"),
      "default style → no output-style section",
    );
    assert(
      defaultPrompt.includes("When solving coding tasks"),
      "default style → coding instructions present",
    );

    // Explanatory (keepCodingInstructions:true) → section present + coding kept
    setActiveOutputStyle("Explanatory");
    const explanatoryPrompt = renderSystemPrompt(await buildSystemPrompt({ cwd }));
    assert(
      explanatoryPrompt.includes("# Output Style: Explanatory"),
      "Explanatory → labelled output-style section present",
    );
    assert(
      explanatoryPrompt.includes("Insight"),
      "Explanatory → Insight instruction injected",
    );
    assert(
      explanatoryPrompt.includes("When solving coding tasks"),
      "Explanatory (keepCodingInstructions=true) → coding instructions kept",
    );

    // Custom style with keepCodingInstructions:false → coding dropped
    setCustomOutputStyles([
      {
        name: "Terse",
        description: "x",
        prompt: "Answer in one sentence.",
        source: "user",
        keepCodingInstructions: false,
      },
    ]);
    setActiveOutputStyle("Terse");
    const tersePrompt = renderSystemPrompt(await buildSystemPrompt({ cwd }));
    assert(
      tersePrompt.includes("# Output Style: Terse"),
      "Terse → output-style section present",
    );
    assert(
      !tersePrompt.includes("When solving coding tasks"),
      "Terse (keepCodingInstructions=false) → coding instructions dropped",
    );
    assert(
      tersePrompt.includes("You are Easy Agent"),
      "Terse → identity framing still present",
    );
  });

  // ─── [5] Argument substitution ─────────────────────────────────
  console.log("\n[5] argument substitution — $ARGUMENTS / $1 / indexed / append");

  assert(
    parseArguments('foo "hello world" bar').join("|") === "foo|hello world|bar",
    "parseArguments honours double quotes",
  );
  assert(
    parseArguments("a 'b c' d").join("|") === "a|b c|d",
    "parseArguments honours single quotes",
  );
  assert(parseArguments("").length === 0, "empty args → empty token list");

  assert(
    substituteArguments("Review $ARGUMENTS now", "src/foo.ts") === "Review src/foo.ts now",
    "$ARGUMENTS replaced with full string",
  );
  assert(
    substituteArguments("First $1 second $2", "alpha beta") === "First alpha second beta",
    "$1/$2 positional substitution",
  );
  assert(
    substituteArguments("Idx $ARGUMENTS[1]", "alpha beta") === "Idx beta",
    "$ARGUMENTS[n] indexed substitution",
  );
  assert(
    substituteArguments("no placeholder here", "extra args") ===
      "no placeholder here\n\nARGUMENTS: extra args",
    "no placeholder + args → ARGUMENTS appended",
  );
  assert(
    substituteArguments("no placeholder", undefined) === "no placeholder",
    "undefined args → content unchanged",
  );
  assert(
    substituteArguments("missing $2 here", "only-one") === "missing  here",
    "out-of-range positional → empty string",
  );

  // ─── [6] Command dir loader ────────────────────────────────────
  console.log("\n[6] command dir loader — naming, namespacing, precedence");

  await withTempEnv(async (home, cwd) => {
    // user command
    await writeFileEnsuringDir(
      path.join(home, ".easy-agent", "commands", "review.md"),
      `---\ndescription: Review a file\nargument-hint: <file>\nmodel: claude-sonnet\nallowed-tools: Read, Grep\n---\nReview $ARGUMENTS thoroughly.`,
    );
    // project command of the same name → project wins
    await writeFileEnsuringDir(
      path.join(cwd, ".easy-agent", "commands", "review.md"),
      `---\ndescription: Project review\n---\nProject review of $ARGUMENTS.`,
    );
    // namespaced command (subdir → `:`)
    await writeFileEnsuringDir(
      path.join(cwd, ".easy-agent", "commands", "team", "standup.md"),
      `Write a standup summary.`,
    );

    const { commands, warnings } = await loadAllUserCommands(cwd);
    assert(warnings.length === 0, "no warnings for valid commands");
    const byName = new Map(commands.map((c) => [c.name, c]));
    assert(byName.has("review"), "review.md → /review");
    assert(byName.has("team:standup"), "team/standup.md → /team:standup");
    assert(
      byName.get("review")?.source === "project",
      "project review overrides user review",
    );
    assert(
      byName.get("review")?.description === "Project review",
      "winning review carries project description",
    );

    // The user-scope command's frontmatter is parsed correctly when loaded alone
    setUserCommands([
      {
        name: "review",
        description: "Review a file",
        argumentHint: "<file>",
        model: "claude-sonnet",
        allowedTools: ["Read", "Grep"],
        body: "Review $ARGUMENTS thoroughly.",
        filePath: "x",
        source: "user",
      },
    ]);
    const cmd = findUserCommand("review");
    assert(cmd?.model === "claude-sonnet", "model frontmatter parsed");
    assert(
      cmd?.allowedTools.join(",") === "Read,Grep",
      "allowed-tools CSV parsed into array",
    );
    assert(cmd?.argumentHint === "<file>", "argument-hint parsed");
    assert(findUserCommand("nope") === undefined, "missing command → undefined");

    // Bootstrap end-to-end populates the registry
    clearUserCommands();
    const bootResult = await bootstrapUserCommands(cwd);
    assert(bootResult.commandCount === 2, "bootstrap loads review + team:standup");
    assert(!!findUserCommand("team:standup"), "bootstrap registers namespaced command");
  });

  // ─── [7] Settings writer round-trip ────────────────────────────
  console.log("\n[7] settings writer — updateUserSettings round-trip");

  await withTempEnv(async (home, cwd) => {
    // Seed an existing key to confirm shallow merge keeps it
    await writeFileEnsuringDir(
      path.join(home, ".easy-agent", "settings.json"),
      JSON.stringify({ existing: "keep-me" }, null, 2),
    );
    await updateUserSettings({ outputStyle: "Explanatory" });

    const written = JSON.parse(
      await fs.readFile(path.join(home, ".easy-agent", "settings.json"), "utf-8"),
    );
    assert(written.outputStyle === "Explanatory", "outputStyle persisted");
    assert(written.existing === "keep-me", "existing keys preserved (shallow merge)");

    const merged = await readMergedStringSetting(cwd, "outputStyle");
    assert(merged === "Explanatory", "readMergedStringSetting reads it back");

    // Project scope wins over user scope
    await writeFileEnsuringDir(
      path.join(cwd, ".easy-agent", "settings.json"),
      JSON.stringify({ outputStyle: "Learning" }, null, 2),
    );
    await trustProjectForSession(cwd);
    const mergedProj = await readMergedStringSetting(cwd, "outputStyle");
    assert(mergedProj === "Learning", "project outputStyle overrides user outputStyle");
  });

  // ─── Summary ────────────────────────────────────────────────────
  console.log("");
  if (failures.length > 0) {
    console.log(`✗ ${failures.length} assertion(s) failed:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log("✓ All stage 23 tests passed.");
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error("Test script crashed:", err);
  process.exit(2);
});

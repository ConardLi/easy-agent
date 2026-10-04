#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkPermission, type PermissionMode, type PermissionSettings } from "../permissions/permissions.js";
import { recordClassifierFailure, resetAutoModeState } from "../permissions/autoModeState.js";
import { analyzeBashCommand, isReadOnlyCommand } from "../tools/bashTool.js";
import { findToolByName } from "../tools/index.js";

const READ_ONLY_CASES = [
  "pwd",
  "git status",
  "git status --short",
  "git log --oneline -5",
  "git diff --stat",
  "git show HEAD:README.md",
  "cat package.json",
  "cat 'file with spaces.txt'",
  "cat file\\ name",
  "c''at README.md",
  "cat foo\\;bar",
  "grep -n 'foo;bar' README.md",
  'grep "a && b" README.md',
  "rg --line-number 'foo|bar' src",
  "find src -type f -name '*.ts'",
  "fd --type f package src",
  "head -n 20 README.md",
  "tail -n 20 README.md",
  "wc -l README.md",
  "sed -n '1,10p' README.md",
  "sed 's/foo/bar/g' README.md",
  "pwd && git status",
  "cat README.md | grep Easy | head -n 2",
  "pwd; git status",
  "pwd\ngit status",
  "cat '$HOME'",
] as const;

const REQUIRES_APPROVAL_CASES = [
  "",
  "cat source > target",
  "cat source >> target",
  "cat < source",
  "cat source 2>&1",
  "cat <<< data",
  "cat <<EOF\ndata\nEOF",
  "sed -i 's/a/b/' file",
  "sed --in-place=.bak 's/a/b/' file",
  "sed --in-pla=.bak 's/a/b/' file",
  "sed -ni 's/a/b/' file",
  "sed 's/a/b/w target' file",
  "sed 'e touch target' file",
  "sed -f commands.sed file",
  "find . -delete",
  "find . -dele",
  "find . -exec rm {} +",
  "find . -execdir sh -c 'touch target' ;",
  "find . -ok rm {} +",
  "find . -okdir rm {} +",
  "find . -fprint target",
  "fd pattern . --exec rm {}",
  "fd pattern . -X rm",
  "rg pattern . --pre 'touch target'",
  "rg pattern . --hostname-bin 'touch target'",
  "git diff --output=target",
  "git diff --out=target",
  "git show --ext-diff HEAD",
  "git log --show-signature",
  "git log --format='%G? %s'",
  "git -c core.pager='touch target' log",
  "cat $(touch target)",
  'cat "$(touch target)"',
  "cat `touch target`",
  "cat <(touch target)",
  "cat >(touch target)",
  "cat ${FILE}",
  "cat $FILE",
  "cat *",
  "cat file; touch target",
  "cat file\ntouch target",
  "cat file && touch target",
  "cat file || touch target",
  "cat file | tee target",
  "cat file & touch target",
  "cat file\\\ntouch target",
  "cat file # comment",
  "(cat file)",
  "{ cat file; }",
  "bash -c 'touch target'",
  "eval 'touch target'",
  "source script.sh",
  "cat 'unterminated",
  "cat trailing\\",
  "pwd &&",
  "| cat file",
] as const;

async function permissionFor(
  mode: PermissionMode,
  command: string,
  cwd: string,
  settingsOverrides: Partial<PermissionSettings> = {},
) {
  const tool = findToolByName("Bash");
  assert.ok(tool, "Bash tool must be registered");
  const settings: PermissionSettings = {
    allow: settingsOverrides.allow ?? [],
    deny: settingsOverrides.deny ?? [],
    mode,
  };
  return checkPermission({ tool, input: { command }, cwd, mode, settings });
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-bash-readonly-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  try {
    for (const command of READ_ONLY_CASES) {
      assert.equal(
        isReadOnlyCommand(command, { platform: "linux" }),
        true,
        `expected POSIX read-only: ${JSON.stringify(command)}`,
      );
    }
    for (const command of REQUIRES_APPROVAL_CASES) {
      assert.equal(
        isReadOnlyCommand(command, { platform: "linux" }),
        false,
        `expected POSIX approval: ${JSON.stringify(command)}`,
      );
    }

    const pipeline = analyzeBashCommand("cat README.md | grep Easy | head -n 2", { platform: "linux" });
    assert.equal(pipeline.isReadOnly, true);
    assert.equal(pipeline.reason, "read_only");
    assert.deepEqual(
      pipeline.commands.map((command) => command.name),
      ["cat", "grep", "head"],
    );

    const redirection = analyzeBashCommand("cat source > target", { platform: "linux" });
    assert.equal(redirection.reason, "unsupported_syntax");
    assert.match(redirection.detail, /redirection/);

    const unsafeArguments = analyzeBashCommand("sed -i 's/a/b/' file", { platform: "linux" });
    assert.equal(unsafeArguments.reason, "unsafe_arguments");
    assert.match(unsafeArguments.detail, /writes files/);

    const unsupportedCommand = analyzeBashCommand("cat file; touch target", { platform: "linux" });
    assert.equal(unsupportedCommand.reason, "unsupported_command");
    assert.deepEqual(
      unsupportedCommand.commands.map((command) => command.name),
      ["cat", "touch"],
    );

    const WINDOWS_SHELL_BYPASS_CASES = [
      "cat '%EVIL%&touch target'",
      "cat %EVIL%",
      "cat !EVIL!",
      "cat file^&touch target",
      "cat foo\\&touch target",
      'cat "file\\"&touch target"',
    ] as const;
    for (const command of WINDOWS_SHELL_BYPASS_CASES) {
      assert.equal(
        isReadOnlyCommand(command, { platform: "win32" }),
        false,
        `expected Windows shell approval: ${JSON.stringify(command)}`,
      );
    }
    assert.equal(isReadOnlyCommand('cat "C:\\Program Files\\file.txt"', { platform: "win32" }), true);
    assert.equal(isReadOnlyCommand("git status && pwd", { platform: "win32" }), true);

    assert.equal((await permissionFor("default", "git status", cwd)).behavior, "allow");
    assert.equal((await permissionFor("plan", "git status", cwd)).behavior, "allow");
    assert.equal((await permissionFor("default", "cat source > target", cwd)).behavior, "ask");
    assert.equal((await permissionFor("plan", "cat source > target", cwd)).behavior, "deny");
    assert.equal((await permissionFor("plan", "find . -delete", cwd)).behavior, "deny");

    resetAutoModeState();
    recordClassifierFailure();
    recordClassifierFailure();
    recordClassifierFailure();
    assert.equal((await permissionFor("auto", "sed -i 's/a/b/' file", cwd)).behavior, "ask");
    resetAutoModeState();

    assert.equal(
      (
        await permissionFor("default", "git status", cwd, {
          deny: ["Bash(git status*)"],
        })
      ).behavior,
      "deny",
      "an explicit Bash deny rule must override read-only auto-allow",
    );

    process.stdout.write(
      `[pass] Bash read-only analysis: ${READ_ONLY_CASES.length} allowed, ` +
        `${REQUIRES_APPROVAL_CASES.length} require approval, ` +
        `${WINDOWS_SHELL_BYPASS_CASES.length} Windows bypasses blocked, permission modes verified.\n`,
    );
  } finally {
    resetAutoModeState();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env tsx

import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureFileHistory,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  getFileHistoryState,
  setFileHistoryState,
} from "../session/fileHistory.js";
import { getPlansRoot, getUserSettingsPath } from "../utils/paths.js";
import { toolResultText, type Tool, type ToolContext } from "../tools/Tool.js";
import { fileEditTool } from "../tools/fileEditTool.js";
import { fileReadTool } from "../tools/fileReadTool.js";
import { fileWriteTool } from "../tools/fileWriteTool.js";
import { globTool } from "../tools/globTool.js";
import { grepTool } from "../tools/grepTool.js";
import { multiEditTool } from "../tools/multiEditTool.js";
import {
  setAdditionalAllowedRoots,
  updateWorkspaceTextFile,
  withValidatedWorkspacePath,
} from "../tools/pathUtils.js";

interface CheckFailure {
  label: string;
  detail?: string;
}

async function call(tool: Tool, input: Record<string, unknown>, cwd: string) {
  const context: ToolContext = { cwd };
  return tool.call(input, context);
}

async function createFileSymlink(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, "file");
}

async function createDirectorySymlink(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-path-boundary-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const additional = path.join(root, "additional");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const failures: CheckFailure[] = [];

  const check = (condition: boolean, label: string, detail?: string) => {
    if (condition) {
      process.stdout.write(`  ✓ ${label}\n`);
    } else {
      failures.push({ label, detail });
      process.stdout.write(`  ✗ ${label}${detail ? ` — ${detail}` : ""}\n`);
    }
  };

  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
    fs.mkdir(additional, { recursive: true }),
  ]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  setAdditionalAllowedRoots([]);

  try {
    process.stdout.write("Normal file-tool behavior remains compatible\n");
    const normalFile = path.join(workspace, "normal.txt");
    await fs.writeFile(normalFile, "alpha\nbeta\n", "utf8");
    const normalRead = await call(fileReadTool, { file_path: normalFile }, workspace);
    check(
      toolResultText(normalRead.content) === `${normalFile} (3 lines)\n1\talpha\n2\tbeta\n3\t`,
      "Read keeps its line-numbered result format",
      toolResultText(normalRead.content),
    );
    const partialRead = await call(
      fileReadTool,
      { file_path: normalFile, offset: 2, limit: 1 },
      workspace,
    );
    check(
      toolResultText(partialRead.content) === `${normalFile} (lines 2-2 of 3)\n2\tbeta`,
      "Read keeps offset and limit semantics",
      toolResultText(partialRead.content),
    );

    const normalNestedFile = path.join(workspace, "normal", "nested.txt");
    const normalCreate = await call(
      fileWriteTool,
      { file_path: normalNestedFile, content: "created\n" },
      workspace,
    );
    check(
      toolResultText(normalCreate.content) === `Created file: ${normalNestedFile} (8 chars)`,
      "Write keeps its create result format",
      toolResultText(normalCreate.content),
    );
    const normalOverwrite = await call(
      fileWriteTool,
      { file_path: normalNestedFile, content: "updated\n" },
      workspace,
    );
    check(
      toolResultText(normalOverwrite.content) === `Updated file: ${normalNestedFile} (8 chars)` &&
        (await fs.readFile(normalNestedFile, "utf8")) === "updated\n",
      "Write keeps overwrite behavior and result format",
      toolResultText(normalOverwrite.content),
    );

    const normalEdit = await call(
      fileEditTool,
      { file_path: normalFile, old_string: "alpha", new_string: "ALPHA" },
      workspace,
    );
    check(
      normalEdit.isError !== true &&
        toolResultText(normalEdit.content).startsWith(`Updated file: ${normalFile}\n`) &&
        (await fs.readFile(normalFile, "utf8")) === "ALPHA\nbeta\n",
      "Edit keeps its replacement and result semantics",
      toolResultText(normalEdit.content),
    );
    const beforeFailedMultiEdit = await fs.readFile(normalFile, "utf8");
    const failedMultiEdit = await call(
      multiEditTool,
      {
        file_path: normalFile,
        edits: [
          { old_string: "ALPHA", new_string: "first" },
          { old_string: "missing", new_string: "second" },
        ],
      },
      workspace,
    );
    check(
      failedMultiEdit.isError === true &&
        (await fs.readFile(normalFile, "utf8")) === beforeFailedMultiEdit,
      "MultiEdit remains atomic when a later edit fails",
      toolResultText(failedMultiEdit.content),
    );

    const normalGrep = await call(grepTool, { path: workspace, pattern: "ALPHA" }, workspace);
    check(
      normalGrep.isError !== true && toolResultText(normalGrep.content).includes("ALPHA"),
      "Grep still searches ordinary workspace files",
      toolResultText(normalGrep.content),
    );
    const normalGlob = await call(globTool, { path: workspace, pattern: "**/*.txt" }, workspace);
    check(
      normalGlob.isError !== true &&
        toolResultText(normalGlob.content).startsWith(`Matched files under ${workspace}:`) &&
        toolResultText(normalGlob.content).includes("normal.txt"),
      "Glob still discovers ordinary workspace files",
      toolResultText(normalGlob.content),
    );

    const outsideFile = path.join(outside, "secret.txt");
    const escapeFile = path.join(workspace, "escape.txt");
    await fs.writeFile(outsideFile, "outside-secret\n", "utf8");
    await createFileSymlink(outsideFile, escapeFile);

    process.stdout.write("File tools reject links that escape an allowed root\n");
    const readEscape = await call(fileReadTool, { file_path: escapeFile }, workspace);
    check(readEscape.isError === true, "Read rejects an escaping file link", toolResultText(readEscape.content));
    check(
      toolResultText(readEscape.content).startsWith("Error: Path resolves outside"),
      "Boundary failures preserve the existing tool error prefix",
      toolResultText(readEscape.content),
    );

    const writeEscape = await call(
      fileWriteTool,
      { file_path: escapeFile, content: "write-bypass\n" },
      workspace,
    );
    check(writeEscape.isError === true, "Write rejects an escaping file link", toolResultText(writeEscape.content));
    check(
      (await fs.readFile(outsideFile, "utf8")) === "outside-secret\n",
      "Write leaves the external target unchanged",
    );
    await fs.writeFile(outsideFile, "outside-secret\n", "utf8");

    const editEscape = await call(
      fileEditTool,
      { file_path: escapeFile, old_string: "outside-secret", new_string: "edit-bypass" },
      workspace,
    );
    check(editEscape.isError === true, "Edit rejects an escaping file link", toolResultText(editEscape.content));
    check(
      (await fs.readFile(outsideFile, "utf8")) === "outside-secret\n",
      "Edit leaves the external target unchanged",
    );
    await fs.writeFile(outsideFile, "outside-secret\n", "utf8");

    const multiEscape = await call(
      multiEditTool,
      {
        file_path: escapeFile,
        edits: [{ old_string: "outside-secret", new_string: "multi-bypass" }],
      },
      workspace,
    );
    check(multiEscape.isError === true, "MultiEdit rejects an escaping file link", toolResultText(multiEscape.content));
    check(
      (await fs.readFile(outsideFile, "utf8")) === "outside-secret\n",
      "MultiEdit leaves the external target unchanged",
    );
    await fs.writeFile(outsideFile, "outside-secret\n", "utf8");

    const outsideDir = path.join(outside, "directory");
    const escapeDir = path.join(workspace, "escape-dir");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "visible.txt"), "external listing\n", "utf8");
    await createDirectorySymlink(outsideDir, escapeDir);

    const readDirectoryEscape = await call(fileReadTool, { file_path: escapeDir }, workspace);
    check(readDirectoryEscape.isError === true, "Read rejects an escaping directory link");
    const grepDirectoryEscape = await call(
      grepTool,
      { path: escapeDir, pattern: "external" },
      workspace,
    );
    check(grepDirectoryEscape.isError === true, "Grep rejects an escaping directory link");
    const globDirectoryEscape = await call(
      globTool,
      { path: escapeDir, pattern: "**/*.txt" },
      workspace,
    );
    check(globDirectoryEscape.isError === true, "Glob rejects an escaping directory link");

    const danglingTarget = path.join(outside, "created-through-link.txt");
    const danglingLink = path.join(workspace, "dangling.txt");
    await createFileSymlink(danglingTarget, danglingLink);
    const danglingWrite = await call(
      fileWriteTool,
      { file_path: danglingLink, content: "created outside\n" },
      workspace,
    );
    check(danglingWrite.isError === true, "Write rejects a dangling link");
    check(
      await fs.access(danglingTarget).then(() => false, () => true),
      "Dangling link does not create its external target",
    );

    const chainOne = path.join(workspace, "chain-one.txt");
    const chainTwo = path.join(workspace, "chain-two.txt");
    await createFileSymlink(outsideFile, chainTwo);
    await createFileSymlink(chainTwo, chainOne);
    check(
      (await call(fileReadTool, { file_path: chainOne }, workspace)).isError === true,
      "Read rejects a link chain that escapes",
    );

    const loopOne = path.join(workspace, "loop-one");
    const loopTwo = path.join(workspace, "loop-two");
    await createFileSymlink(loopTwo, loopOne);
    await createFileSymlink(loopOne, loopTwo);
    check(
      (await call(fileReadTool, { file_path: loopOne }, workspace)).isError === true,
      "Read rejects a symbolic-link loop",
    );

    process.stdout.write("Links that remain inside an allowed root keep working\n");
    const internalFile = path.join(workspace, "internal.txt");
    const internalLink = path.join(workspace, "internal-link.txt");
    await fs.writeFile(internalFile, "internal\n", "utf8");
    await createFileSymlink(internalFile, internalLink);
    check(
      (await call(fileReadTool, { file_path: internalLink }, workspace)).isError !== true,
      "Read accepts an internal file link",
    );
    check(
      (await call(
        fileEditTool,
        { file_path: internalLink, old_string: "internal", new_string: "updated" },
        workspace,
      )).isError !== true,
      "Edit accepts an internal file link",
    );
    check((await fs.readFile(internalFile, "utf8")) === "updated\n", "Internal link updates its in-root target");

    const internalDirectory = path.join(workspace, "internal-directory");
    const internalDirectoryLink = path.join(workspace, "internal-directory-link");
    await fs.mkdir(internalDirectory);
    await fs.writeFile(path.join(internalDirectory, "entry.txt"), "entry\n", "utf8");
    await createDirectorySymlink(internalDirectory, internalDirectoryLink);
    check(
      (await call(fileReadTool, { file_path: internalDirectoryLink }, workspace)).isError !== true,
      "Read accepts an internal directory link",
    );
    const internalGlob = await call(
      globTool,
      { path: internalDirectoryLink, pattern: "**/*.txt" },
      workspace,
    );
    check(
      toolResultText(internalGlob.content).startsWith(`Matched files under ${internalDirectoryLink}:`),
      "Glob keeps the requested path in normal result text",
      toolResultText(internalGlob.content),
    );

    const nestedFile = path.join(workspace, "new", "nested", "file.txt");
    check(
      (await call(fileWriteTool, { file_path: nestedFile, content: "created\n" }, workspace)).isError !== true,
      "Write creates a nested file inside the workspace",
    );
    check((await fs.readFile(nestedFile, "utf8")) === "created\n", "Nested file contains the requested content");
    check(
      (await call(fileWriteTool, { file_path: nestedFile, content: "overwritten\n" }, workspace)).isError !== true,
      "Write overwrites an existing regular file",
    );
    check((await fs.readFile(nestedFile, "utf8")) === "overwritten\n", "Overwrite replaces the complete file");
    if (process.platform !== "win32") {
      await fs.chmod(nestedFile, 0o640);
      await call(fileWriteTool, { file_path: nestedFile, content: "mode-preserved\n" }, workspace);
      check(
        ((await fs.stat(nestedFile)).mode & 0o777) === 0o640,
        "Overwriting an existing file preserves its mode",
      );
    }

    setAdditionalAllowedRoots([additional]);
    const additionalFile = path.join(additional, "allowed.txt");
    await fs.writeFile(additionalFile, "additional\n", "utf8");
    check(
      (await call(fileReadTool, { file_path: additionalFile }, workspace)).isError !== true,
      "Read accepts a configured additional root",
    );
    const additionalAlias = path.join(root, "additional-alias");
    await createDirectorySymlink(additional, additionalAlias);
    setAdditionalAllowedRoots([additionalAlias]);
    check(
      (await call(fileReadTool, { file_path: path.join(additionalAlias, "allowed.txt") }, workspace)).isError !== true,
      "A configured root may itself be a symbolic link",
    );
    setAdditionalAllowedRoots([additional]);
    const additionalEscape = path.join(additional, "escape.txt");
    await createFileSymlink(outsideFile, additionalEscape);
    check(
      (await call(fileReadTool, { file_path: additionalEscape }, workspace)).isError === true,
      "Additional roots cannot escape through a link",
    );
    setAdditionalAllowedRoots([]);

    process.stdout.write("Ordinary file tools expose only the required internal state\n");
    const userSettings = getUserSettingsPath();
    await fs.mkdir(path.dirname(userSettings), { recursive: true });
    await fs.writeFile(userSettings, '{"env":{"TOKEN":"secret"}}\n', "utf8");
    check(
      (await call(fileReadTool, { file_path: userSettings }, workspace)).isError === true,
      "Read cannot access user settings through the global state root",
    );
    const settingsWrite = await call(
      fileWriteTool,
      { file_path: userSettings, content: "replaced\n" },
      workspace,
    );
    check(settingsWrite.isError === true, "Write cannot access user settings through the global state root");
    check(
      (await fs.readFile(userSettings, "utf8")) === '{"env":{"TOKEN":"secret"}}\n',
      "Blocked settings write leaves the file unchanged",
    );
    const planFile = path.join(getPlansRoot(), "boundary-test.md");
    check(
      (await call(fileWriteTool, { file_path: planFile, content: "plan\n" }, workspace)).isError !== true,
      "Write can access the dedicated plans root",
    );
    const planEscape = path.join(getPlansRoot(), "settings-link.json");
    await createFileSymlink(userSettings, planEscape);
    check(
      (await call(fileReadTool, { file_path: planEscape }, workspace)).isError === true,
      "The plans root cannot link to other global state",
    );

    if (process.platform !== "win32") {
      process.stdout.write("Open file descriptors contain path replacement races\n");
      const updateRaceFile = path.join(workspace, "update-race.txt");
      const updateRaceOutside = path.join(outside, "update-race-target.txt");
      await fs.writeFile(updateRaceFile, "inside-before-race\n", "utf8");
      await fs.writeFile(updateRaceOutside, "outside-before-race\n", "utf8");
      await updateWorkspaceTextFile(updateRaceFile, workspace, () => {
        fsSync.unlinkSync(updateRaceFile);
        fsSync.symlinkSync(updateRaceOutside, updateRaceFile);
        return { content: "descriptor-only-update\n", value: undefined };
      });
      check(
        (await fs.readFile(updateRaceOutside, "utf8")) === "outside-before-race\n",
        "An edit writes only to the validated descriptor after path replacement",
      );

      const readRaceFile = path.join(workspace, "read-race.txt");
      const readRaceOutside = path.join(outside, "read-race-target.txt");
      await fs.writeFile(readRaceFile, "inside-read\n", "utf8");
      await fs.writeFile(readRaceOutside, "outside-read\n", "utf8");
      let readRaceRejected = false;
      try {
        await withValidatedWorkspacePath(readRaceFile, workspace, async (resolvedPath) => {
          await fs.unlink(resolvedPath);
          await createFileSymlink(readRaceOutside, resolvedPath);
          return fs.readFile(resolvedPath, "utf8");
        });
      } catch {
        readRaceRejected = true;
      }
      check(readRaceRejected, "A path-based read discards results when the target identity changes");
    }

    process.stdout.write("File history uses the same path boundary\n");
    await configureFileHistory(workspace, "boundary-track");
    await fileHistoryMakeSnapshot("track");
    await fileHistoryTrackEdit(escapeFile, "track");
    check(
      !getFileHistoryState().trackedFiles.has("escape.txt"),
      "File history does not back up an escaping link",
    );

    const raceFile = path.join(workspace, "race.txt");
    const raceOutside = path.join(outside, "race-target.txt");
    await fs.writeFile(raceFile, "original\n", "utf8");
    await fs.writeFile(raceOutside, "outside-race\n", "utf8");
    await configureFileHistory(workspace, "boundary-race");
    await fileHistoryMakeSnapshot("race");
    await fileHistoryTrackEdit(raceFile, "race");
    await fs.writeFile(raceFile, "changed\n", "utf8");
    await fs.unlink(raceFile);
    await createFileSymlink(raceOutside, raceFile);
    await fileHistoryRewind("race");
    check(
      (await fs.readFile(raceOutside, "utf8")) === "outside-race\n",
      "Rewind does not follow a replacement link outside the workspace",
    );

    const createdAfterSnapshot = path.join(workspace, "created-after-snapshot.txt");
    const internalVictim = path.join(workspace, "internal-victim.txt");
    await fs.writeFile(internalVictim, "keep-internal-victim\n", "utf8");
    await configureFileHistory(workspace, "boundary-created-replacement");
    await fileHistoryMakeSnapshot("created-replacement");
    await fileHistoryTrackEdit(createdAfterSnapshot, "created-replacement");
    await fs.writeFile(createdAfterSnapshot, "new-file\n", "utf8");
    await fs.unlink(createdAfterSnapshot);
    await createFileSymlink(internalVictim, createdAfterSnapshot);
    await fileHistoryRewind("created-replacement");
    check(
      (await fs.readFile(internalVictim, "utf8")) === "keep-internal-victim\n",
      "Rewind never deletes the target of a replacement link",
    );
    check(
      await fs.lstat(createdAfterSnapshot).then(() => false, () => true),
      "Rewind removes the replacement link when restoring a missing path",
    );

    const historySource = path.join(workspace, "history-source.txt");
    const maliciousTarget = path.join(outside, "malicious-restore.txt");
    await fs.writeFile(historySource, "history-source\n", "utf8");
    await fs.writeFile(maliciousTarget, "outside-history\n", "utf8");
    await configureFileHistory(workspace, "boundary-restored-state");
    await fileHistoryMakeSnapshot("restored-state");
    await fileHistoryTrackEdit(historySource, "restored-state");
    const sourceState = getFileHistoryState();
    const sourceSnapshot = sourceState.snapshots[0]!;
    const sourceBackup = sourceSnapshot.trackedFileBackups["history-source.txt"]!;
    setFileHistoryState({
      snapshots: [{
        messageId: "malicious",
        timestamp: new Date().toISOString(),
        trackedFileBackups: { [maliciousTarget]: sourceBackup },
      }],
      trackedFiles: new Set([maliciousTarget]),
      snapshotSequence: 1,
    });
    await fileHistoryRewind("malicious");
    check(
      (await fs.readFile(maliciousTarget, "utf8")) === "outside-history\n",
      "Rewind ignores an out-of-root path restored from session state",
    );

    assert.equal(
      failures.length,
      0,
      failures.map((failure) => `${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`).join("\n"),
    );
    process.stdout.write("\n[pass] Workspace path boundary verified.\n");
  } finally {
    setAdditionalAllowedRoots([]);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

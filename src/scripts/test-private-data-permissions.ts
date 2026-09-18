import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-private-data-"));
const home = path.join(sandbox, "home");
const workspace = path.join(sandbox, "workspace");
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousDebugStream = process.env.EASY_AGENT_DEBUG_STREAM;

function permissions(stat: Stats): number {
  return stat.mode & 0o777;
}

async function expectMode(filePath: string, expected: number): Promise<void> {
  if (process.platform === "win32") return;
  assert.equal(permissions(await fs.stat(filePath)), expected, filePath);
}

try {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.EASY_AGENT_DEBUG_STREAM = "1";
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace, { recursive: true, mode: 0o755 });

  const easyHome = path.join(home, ".easy-agent");
  const legacyFiles = [
    path.join(easyHome, "settings.json"),
    path.join(easyHome, "state.json"),
    path.join(easyHome, "stream-debug.log"),
    path.join(easyHome, "projects", "legacy-project", "legacy.jsonl"),
    path.join(easyHome, "tasks", "legacy-list", "1.json"),
    path.join(easyHome, "teams", "legacy-team", "team.json"),
    path.join(easyHome, "plans", "legacy.md"),
  ];
  for (const filePath of legacyFiles) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
    await fs.writeFile(filePath, `legacy:${path.basename(filePath)}\n`, { mode: 0o644 });
    if (process.platform !== "win32") await fs.chmod(filePath, 0o644);
  }
  if (process.platform !== "win32") await fs.chmod(easyHome, 0o755);

  const backup = path.join(easyHome, "file-history", "legacy-session", "script-backup");
  await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o755 });
  await fs.writeFile(backup, "#!/bin/sh\n", { mode: 0o755 });
  const pluginScript = path.join(easyHome, "plugins", "cache", "demo", "run.sh");
  await fs.mkdir(path.dirname(pluginScript), { recursive: true, mode: 0o755 });
  await fs.writeFile(pluginScript, "#!/bin/sh\n", { mode: 0o755 });
  await fs.mkdir(path.join(easyHome, "plugins", "data"), { recursive: true, mode: 0o755 });

  const projectSettingsDir = path.join(workspace, ".easy-agent");
  const projectSettings = path.join(projectSettingsDir, "settings.json");
  const localSettings = path.join(projectSettingsDir, "settings.local.json");
  await fs.mkdir(projectSettingsDir, { recursive: true, mode: 0o755 });
  await fs.writeFile(projectSettings, "{}\n", { mode: 0o644 });
  await fs.writeFile(localSettings, '{"env":{"PRIVATE_TOKEN":"legacy"}}\n', { mode: 0o644 });
  if (process.platform !== "win32") {
    await fs.chmod(projectSettingsDir, 0o755);
    await fs.chmod(projectSettings, 0o644);
    await fs.chmod(localSettings, 0o644);
  }

  const { hardenPrivateDataStorage, inspectPrivateDataSecurity } = await import(
    "../utils/privateData.js"
  );
  const report = await hardenPrivateDataStorage({ forceMigration: true, projectCwd: workspace });
  if (process.platform === "win32") {
    assert.equal(report.supported, false);
  } else {
    assert.equal(report.supported, true);
    assert.equal(report.migrated, true);
    assert.deepEqual(report.issues, []);
    await expectMode(easyHome, 0o700);
    for (const filePath of legacyFiles) await expectMode(filePath, 0o600);
    await expectMode(path.dirname(legacyFiles[3]!), 0o700);
    await expectMode(path.dirname(legacyFiles[4]!), 0o700);
    await expectMode(path.dirname(legacyFiles[5]!), 0o700);
    await expectMode(path.join(easyHome, "plugins"), 0o700);
    await expectMode(path.join(easyHome, "plugins", "data"), 0o700);
    await expectMode(backup, 0o755);
    await expectMode(pluginScript, 0o755);
    await expectMode(projectSettingsDir, 0o755);
    await expectMode(projectSettings, 0o644);
    await expectMode(localSettings, 0o600);
    assert.equal((await inspectPrivateDataSecurity(workspace)).issues.length, 0);

    const outsideTarget = path.join(sandbox, "outside-target.txt");
    await fs.writeFile(outsideTarget, "outside\n", { mode: 0o644 });
    await fs.chmod(outsideTarget, 0o644);
    const linkedEntry = path.join(easyHome, "projects", "linked-target");
    await fs.symlink(outsideTarget, linkedEntry);
    const symlinkReport = await hardenPrivateDataStorage({ forceMigration: true, projectCwd: workspace });
    assert.ok(symlinkReport.issues.some((issue) => issue.path === linkedEntry));
    await expectMode(outsideTarget, 0o644);
    await fs.unlink(linkedEntry);
  }
  assert.equal(await fs.readFile(legacyFiles[3]!, "utf8"), "legacy:legacy.jsonl\n");

  const {
    updateLocalSettings,
    updateProjectSettings,
    updateUserSettings,
  } = await import("../utils/settings.js");
  await updateUserSettings({ models: { secure: { apiKey: "top-secret" } } });
  await updateProjectSettings(workspace, { language: "en" });
  await updateLocalSettings(workspace, { env: { PRIVATE_TOKEN: "local-secret" } });
  await expectMode(path.join(easyHome, "settings.json"), 0o600);
  await expectMode(projectSettings, 0o644);
  await expectMode(localSettings, 0o600);
  await expectMode(projectSettingsDir, 0o755);

  const { resetGlobalStateCache, saveGlobalState } = await import("../config/globalState.js");
  resetGlobalStateCache();
  await saveGlobalState((state) => {
    state.prefs.secure = true;
  });
  await expectMode(path.join(easyHome, "state.json"), 0o600);

  const { configureSessionPersistence, initSessionStorage, appendTranscriptEntry } = await import(
    "../session/storage.js"
  );
  configureSessionPersistence(true);
  const sessionId = "private-session";
  const sessionPaths = await initSessionStorage({
    sessionId,
    cwd: workspace,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    model: "test-model",
  });
  await appendTranscriptEntry(workspace, sessionId, {
    type: "system",
    timestamp: new Date(0).toISOString(),
    level: "info",
    message: "private transcript",
  });
  await expectMode(sessionPaths.projectDir, 0o700);
  await expectMode(sessionPaths.transcriptPath, 0o600);
  await expectMode(sessionPaths.latestPath, 0o600);

  const { writePlan, getPlanFilePath } = await import("../context/plans.js");
  await writePlan("private plan\n");
  await expectMode(getPlanFilePath(), 0o600);

  const { createTask, getTaskPath } = await import("../state/taskStore.js");
  const taskId = await createTask(sessionId, {
    subject: "private task",
    description: "private task body",
    status: "pending",
    blocks: [],
    blockedBy: [],
  });
  await expectMode(getTaskPath(sessionId, taskId), 0o600);

  const { writeProjectMemory } = await import("../context/memory/memdir.js");
  const memory = await writeProjectMemory({
    cwd: workspace,
    name: "Private memory",
    description: "permission test",
    type: "project",
    content: "private memory body",
  });
  await expectMode(memory.filePath, 0o600);

  const { ensureTaskOutputFile, appendTaskOutput } = await import("../utils/taskOutput.js");
  const outputFile = await ensureTaskOutputFile(sessionId, "agent-1");
  await appendTaskOutput(outputFile, { type: "text", text: "private output" });
  await expectMode(outputFile, 0o600);

  const { writeTeamFileAsync, getTeamFilePath } = await import("../utils/teamHelpers.js");
  await writeTeamFileAsync("private-team", {
    name: "private-team",
    createdAt: 0,
    leadAgentId: "team-lead@private-team",
    members: [],
  });
  await expectMode(getTeamFilePath("private-team"), 0o600);

  const { writeToMailbox, getInboxPath } = await import("../utils/teammateMailbox.js");
  await writeToMailbox(
    "reviewer",
    { from: "team-lead", text: "private message", timestamp: new Date(0).toISOString() },
    "private-team",
  );
  await expectMode(getInboxPath("reviewer", "private-team"), 0o600);

  const { writeStreamDebug, rotateStreamDebugLog } = await import("../utils/streamDebug.js");
  writeStreamDebug("security_test", {
    authorization: "Bearer raw-auth-token",
    apiKey: "raw-api-key",
    url: "https://user:password@example.com/v1?q=secret-query",
    text: "ordinary content",
  });
  const debugLog = path.join(easyHome, "stream-debug.log");
  const debugText = await fs.readFile(debugLog, "utf8");
  assert.doesNotMatch(debugText, /raw-auth-token|raw-api-key|password|secret-query/);
  assert.match(debugText, /\[redacted\]|query redacted/);
  assert.match(debugText, /ordinary content/);
  await expectMode(debugLog, 0o600);
  rotateStreamDebugLog(debugLog, 1, 2, 1);
  await expectMode(`${debugLog}.1`, 0o600);

  console.log("Private data permission checks passed.");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousDebugStream === undefined) delete process.env.EASY_AGENT_DEBUG_STREAM;
  else process.env.EASY_AGENT_DEBUG_STREAM = previousDebugStream;
  await fs.rm(sandbox, { recursive: true, force: true });
}

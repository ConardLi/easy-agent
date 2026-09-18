import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import {
  atomicWriteFile,
  atomicWriteFileFromHandle,
  ConcurrentFileModificationError,
  PersistentDataError,
} from "../utils/atomicFile.js";

const scriptPath = fileURLToPath(import.meta.url);
const childMode = process.argv[2];

if (childMode === "crash-writer") {
  const target = process.argv[3]!;
  const ready = process.argv[4]!;
  await atomicWriteFile(target, "replacement\n", {
    beforeCommit: async () => {
      await fs.writeFile(ready, "ready\n");
      await new Promise(() => {});
    },
  });
  process.exit(0);
}

if (childMode === "settings-writer") {
  const { updateUserSettings } = await import("../utils/settings.js");
  await updateUserSettings({ [process.argv[3]!]: process.argv[4]! });
  process.exit(0);
}

if (childMode === "team-writer") {
  const { addTeamMember } = await import("../utils/teamHelpers.js");
  const name = process.argv[4]!;
  await addTeamMember(process.argv[3]!, {
    agentId: `${name}@${process.argv[3]!}`,
    name,
    joinedAt: Date.now(),
    isActive: true,
  });
  process.exit(0);
}

if (childMode === "task-writer") {
  const { updateTask } = await import("../state/taskStore.js");
  const field = process.argv[5] as "subject" | "description";
  await updateTask(process.argv[3]!, process.argv[4]!, { [field]: process.argv[6]! });
  process.exit(0);
}

if (childMode === "session-writer") {
  const { appendTranscriptEntry } = await import("../session/storage.js");
  const value = process.argv[5]!;
  await appendTranscriptEntry(process.argv[3]!, process.argv[4]!, {
    type: "message",
    timestamp: new Date().toISOString(),
    role: "user",
    message: { role: "user", content: value },
  });
  process.exit(0);
}

function spawnChild(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited with code=${String(code)} signal=${String(signal)}: ${stderr}`));
    };
    child.once("error", reject);
    child.once("exit", settle);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener("exit", settle);
      settle(child.exitCode, child.signalCode);
    }
  });
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function expectPersistentDataError(operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => error instanceof PersistentDataError);
}

async function main(): Promise<void> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-persistence-"));
  const home = path.join(sandbox, "home");
  const workspace = path.join(sandbox, "workspace");
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;

  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await fs.mkdir(workspace, { recursive: true });
    const childEnv = { ...process.env, HOME: home, USERPROFILE: home };

    const crashDir = path.join(sandbox, "crash");
    await fs.mkdir(crashDir);
    const crashTarget = path.join(crashDir, "state.json");
    const crashReady = path.join(crashDir, "ready");
    await fs.writeFile(crashTarget, "original\n");
    const crashingChild = spawnChild(["crash-writer", crashTarget, crashReady], childEnv);
    const crashingChildExited = new Promise<void>((resolve) => crashingChild.once("exit", () => resolve()));
    await waitForFile(crashReady);
    crashingChild.kill("SIGKILL");
    await crashingChildExited;
    assert.equal(await fs.readFile(crashTarget, "utf8"), "original\n");

    const failureTarget = path.join(sandbox, "failure.json");
    await fs.writeFile(failureTarget, "before\n", { mode: 0o640 });
    await assert.rejects(
      atomicWriteFile(failureTarget, "after\n", {
        beforeCommit: () => {
          throw new Error("injected before rename");
        },
      }),
      /injected before rename/,
    );
    assert.equal(await fs.readFile(failureTarget, "utf8"), "before\n");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(failureTarget)).mode & 0o777, 0o640);
    }

    const streamingSource = path.join(sandbox, "streaming-source.bin");
    const streamingTarget = path.join(sandbox, "streaming-target.bin");
    const streamingData = Buffer.alloc(200_000, 0x5a);
    await fs.writeFile(streamingSource, streamingData);
    const streamingHandle = await fs.open(streamingSource, "r");
    try {
      await atomicWriteFileFromHandle(streamingTarget, streamingHandle);
    } finally {
      await streamingHandle.close();
    }
    assert.deepEqual(await fs.readFile(streamingTarget), streamingData);

    const settingChildren = Array.from({ length: 8 }, (_, index) =>
      spawnChild(["settings-writer", `key${index}`, `value${index}`], childEnv),
    );
    await Promise.all(settingChildren.map(waitForExit));
    const settingsPath = path.join(home, ".easy-agent", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    for (let index = 0; index < 8; index += 1) {
      assert.equal(settings[`key${index}`], `value${index}`);
    }

    const { updateUserSettings } = await import("../utils/settings.js");
    const invalidSettings = "{ invalid settings\n";
    await fs.writeFile(settingsPath, invalidSettings);
    await expectPersistentDataError(() => updateUserSettings({ safe: true }));
    assert.equal(await fs.readFile(settingsPath, "utf8"), invalidSettings);

    const {
      getGlobalState,
      getGlobalStateDiagnostics,
      resetGlobalStateCache,
      saveGlobalState,
    } = await import("../config/globalState.js");
    const statePath = path.join(home, ".easy-agent", "state.json");
    await fs.writeFile(statePath, '{"version":0,"prefs":{"legacy":true},"projects":{}}\n');
    resetGlobalStateCache();
    assert.equal((await getGlobalState()).prefs.legacy, true);
    const invalidState = "{ invalid state\n";
    await fs.writeFile(statePath, invalidState);
    resetGlobalStateCache();
    assert.deepEqual((await getGlobalState()).prefs, {});
    assert.equal(getGlobalStateDiagnostics().length, 1);
    await expectPersistentDataError(() => saveGlobalState((state) => {
      state.prefs.changed = true;
    }));
    assert.equal(await fs.readFile(statePath, "utf8"), invalidState);

    const { getInstalledPluginsPath } = await import("../plugins/paths.js");
    const { updateInstalledPlugins } = await import("../plugins/state.js");
    const pluginStatePath = getInstalledPluginsPath();
    await fs.mkdir(path.dirname(pluginStatePath), { recursive: true });
    const invalidPluginState = "{ invalid plugin state\n";
    await fs.writeFile(pluginStatePath, invalidPluginState);
    await expectPersistentDataError(() => updateInstalledPlugins((state) => {
      state.plugins.example = {
        pluginId: "example",
        name: "example",
        marketplace: "test",
        version: "1.0.0",
        installPath: "/tmp/example",
        installedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    }));
    assert.equal(await fs.readFile(pluginStatePath, "utf8"), invalidPluginState);

    const {
      createTask,
      getTask,
      getTaskPath,
    } = await import("../state/taskStore.js");
    const taskListId = "persistence-test";
    const taskId = await createTask(taskListId, {
      subject: "original subject",
      description: "original description",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const taskChildren = [
      spawnChild(["task-writer", taskListId, taskId, "subject", "updated subject"], childEnv),
      spawnChild(["task-writer", taskListId, taskId, "description", "updated description"], childEnv),
    ];
    await Promise.all(taskChildren.map(waitForExit));
    const updatedTask = await getTask(taskListId, taskId);
    assert.equal(updatedTask?.subject, "updated subject");
    assert.equal(updatedTask?.description, "updated description");
    const taskPath = getTaskPath(taskListId, taskId);
    const invalidTask = "{ invalid task\n";
    await fs.writeFile(taskPath, invalidTask);
    await expectPersistentDataError(() => getTask(taskListId, taskId));
    assert.equal(await fs.readFile(taskPath, "utf8"), invalidTask);

    const {
      getTeamFilePath,
      readTeamFileAsync,
      writeTeamFileAsync,
    } = await import("../utils/teamHelpers.js");
    const teamName = "persistence-team";
    await writeTeamFileAsync(teamName, {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId: `${teamName}-lead`,
      members: [],
    });
    const teamChildren = Array.from({ length: 6 }, (_, index) =>
      spawnChild(["team-writer", teamName, `member-${index}`], childEnv),
    );
    await Promise.all(teamChildren.map(waitForExit));
    assert.equal((await readTeamFileAsync(teamName))?.members.length, 6);
    const teamPath = getTeamFilePath(teamName);
    const invalidTeam = "{ invalid team\n";
    await fs.writeFile(teamPath, invalidTeam);
    await expectPersistentDataError(() => readTeamFileAsync(teamName));
    assert.equal(await fs.readFile(teamPath, "utf8"), invalidTeam);

    const {
      getInboxPath,
      readMailbox,
      writeToMailbox,
    } = await import("../utils/teammateMailbox.js");
    await writeToMailbox("recipient", {
      from: "sender",
      text: "hello",
      timestamp: new Date().toISOString(),
    }, "mailbox-team");
    const inboxPath = getInboxPath("recipient", "mailbox-team");
    const invalidMailbox = "{ invalid mailbox\n";
    await fs.writeFile(inboxPath, invalidMailbox);
    await expectPersistentDataError(() => readMailbox("recipient", "mailbox-team"));
    assert.equal(await fs.readFile(inboxPath, "utf8"), invalidMailbox);

    const {
      initSessionStorage,
      restoreSession,
    } = await import("../session/storage.js");
    const sessionId = "persistence-session";
    const sessionPaths = await initSessionStorage({
      sessionId,
      cwd: workspace,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      model: "test-model",
    });
    const sessionChildren = Array.from({ length: 5 }, (_, index) =>
      spawnChild(["session-writer", workspace, sessionId, `message-${index}`], childEnv),
    );
    await Promise.all(sessionChildren.map(waitForExit));
    assert.equal((await restoreSession(workspace, sessionId)).messages.length, 5);
    await fs.appendFile(sessionPaths.transcriptPath, "{ invalid transcript\n");
    await expectPersistentDataError(() => restoreSession(workspace, sessionId));

    const { updateWorkspaceTextFile } = await import("../tools/pathUtils.js");
    const editPath = path.join(workspace, "edit.txt");
    await fs.writeFile(editPath, "original text\n");
    await assert.rejects(
      updateWorkspaceTextFile(editPath, workspace, async (original) => {
        assert.equal(original, "original text\n");
        await fs.writeFile(editPath, "external change\n");
        return { content: "agent change\n", value: 1 };
      }),
      (error: unknown) => error instanceof ConcurrentFileModificationError,
    );
    assert.equal(await fs.readFile(editPath, "utf8"), "external change\n");

    console.log("Atomic persistence checks passed.");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

await main();

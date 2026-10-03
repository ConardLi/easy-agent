import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const GOLDEN_PATH = path.join(import.meta.dirname, "__golden__", "config-session-characterization.golden.txt");
const STARTED_AT = "2026-01-02T03:04:05.000Z";
const UPDATED_AT = "2026-01-02T03:05:06.000Z";

function stableJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, current) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) return current;
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
      );
    },
    2,
  );
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function buildRecording(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-agent-config-session-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true })]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const sources = await import("../config/sources.js");
  const paths = await import("../utils/paths.js");
  const storage = await import("../session/storage.js");

  try {
    await writeJson(paths.getUserSettingsPath(), {
      model: "user-model",
      outputStyle: "user-style",
      allow: ["Read", "Grep"],
    });
    await writeJson(paths.getProjectSettingsPath(cwd), {
      model: "project-model",
      outputStyle: "project-style",
      allow: ["Edit", "Read"],
    });
    await writeJson(paths.getLocalSettingsPath(cwd), {
      outputStyle: "local-style",
      allow: ["Glob"],
    });
    sources.setFlagSettings({ model: "flag-model", allow: ["Bash(git status)"] });

    const loaded = await sources.loadSettingSources(cwd);
    const localSources = loaded.filter((source) => source.source !== "policy");
    const configSnapshot = {
      order: loaded.map((source) => source.source),
      sources: localSources.map((source) => ({ source: source.source, raw: source.raw })),
      resolved: {
        model: sources.getScalarSetting(localSources, "model"),
        outputStyle: sources.getScalarSetting(localSources, "outputStyle"),
        allow: sources.getMergedStringArray(localSources, (raw) =>
          Array.isArray(raw?.allow) ? raw.allow.filter((value): value is string => typeof value === "string") : [],
        ),
      },
    };

    storage.configureSessionPersistence(true);
    const sessionId = "session-contract";
    const sessionPaths = await storage.initSessionStorage({
      sessionId,
      cwd,
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
      model: "fixture-model",
    });
    await storage.appendTranscriptEntry(cwd, sessionId, {
      type: "message",
      timestamp: "2026-01-02T03:04:10.000Z",
      role: "user",
      messageId: "user-1",
      message: { role: "user", content: "Review this file." },
    });
    await storage.appendTranscriptEntry(cwd, sessionId, {
      type: "message",
      timestamp: "2026-01-02T03:04:20.000Z",
      role: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    });
    await storage.appendTranscriptEntry(cwd, sessionId, {
      type: "usage",
      timestamp: UPDATED_AT,
      turn: { input_tokens: 12, output_tokens: 3 },
      total: { input_tokens: 12, output_tokens: 3 },
    });
    await storage.appendTranscriptEntry(cwd, sessionId, {
      type: "file_history_snapshot",
      timestamp: "2026-01-02T03:05:07.000Z",
      snapshot: {
        messageId: "user-1",
        trackedFileBackups: {
          "src/example.ts": {
            backupFileName: "example.ts.v1",
            version: 1,
            backupTime: "2026-01-02T03:04:09.000Z",
          },
        },
        timestamp: "2026-01-02T03:04:09.000Z",
      },
    });

    const transcript = (await readFile(sessionPaths.transcriptPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((entry) => {
        if (entry.type === "session_meta") entry.cwd = "<CWD>";
        return entry;
      });
    const restored = await storage.restoreSession(cwd, sessionId);
    const latest = (await readFile(sessionPaths.latestPath, "utf8")).trim();
    const sessionSnapshot = {
      paths: {
        transcript: "<HOME>/.easy-agent/projects/<PROJECT>/session-contract.jsonl",
        latest: "<HOME>/.easy-agent/projects/<PROJECT>/latest",
      },
      latest,
      transcript,
      restored: {
        ...restored,
        summary: { ...restored.summary, cwd: "<CWD>" },
      },
    };

    return `### configuration\n${stableJson(configSnapshot)}\n\n### session\n${stableJson(sessionSnapshot)}`;
  } finally {
    sources.setFlagSettings(null);
    sources.resetSettingsCache();
    storage.configureSessionPersistence(true);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const recording = await buildRecording();
  const update = process.argv.includes("--update");
  await mkdir(path.dirname(GOLDEN_PATH), { recursive: true });

  if (update) {
    await writeFile(GOLDEN_PATH, recording, "utf8");
    process.stdout.write(`[updated] golden written to ${GOLDEN_PATH}\n`);
    return;
  }

  const golden = (await readFile(GOLDEN_PATH, "utf8")).replace(/\r\n?/g, "\n");
  assert.equal(
    recording,
    golden,
    "Configuration/session characterization mismatch; use --update only for intentional changes",
  );
  process.stdout.write(
    `[pass] Configuration/session characterization matches golden (${recording.split("\n").length} lines).\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});

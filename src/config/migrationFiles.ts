import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { z } from "zod";
import {
  migrateSettings,
  migrateLegacyEnvironment,
  legacyDefaultModelIsShadowed,
  savedProfileOwnsConnection,
} from "./migration.js";
import { configurationEnvironment } from "./environment.js";
import { redactSettingValue } from "./redaction.js";
import { validateSettings } from "./schema.js";
import { ConfigurationError } from "./values.js";
import { getFlagSettings, resetSettingsCache, type LoadedSource } from "./sources.js";
import { getManagedSettingsPath } from "./managedPath.js";
import { isProjectTrusted } from "./globalState.js";
import { readJsonSettingsFile } from "../utils/settings.js";
import { getLocalSettingsPath, getProjectSettingsPath, getUserSettingsPath } from "../utils/paths.js";
import { atomicWriteFile, withFileLock } from "../utils/atomicFile.js";
import { writePrivateFile } from "../utils/privateData.js";
import { defineRuntimeState } from "../state/runtimeScope.js";

export const ConfigScopeSchema = z.enum(["user", "project", "local"]);
export const MigrationPreviewSchema = z.object({
  path: z.string(),
  revision: z.string(),
  changed: z.boolean(),
  changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  notices: z.array(z.object({ level: z.enum(["info", "warning", "error"]), field: z.string(), message: z.string() })),
});
export const MigrationApplySchema = z.object({
  changed: z.boolean(),
  backup: z.string().nullable(),
  reload: z.literal("restart"),
});
export type ConfigMigrationPreview = z.infer<typeof MigrationPreviewSchema>;
export type ConfigMigrationResult = z.infer<typeof MigrationApplySchema>;
type Scope = z.infer<typeof ConfigScopeSchema>;
const revisionScope = defineRuntimeState("configMigrationRevision", () => randomUUID());

function fileFor(cwd: string, scope: Scope): string {
  return scope === "user"
    ? getUserSettingsPath()
    : scope === "local"
      ? getLocalSettingsPath(cwd)
      : getProjectSettingsPath(cwd);
}

async function readMigration(file: string, scope: Scope, cwd: string) {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = "{}";
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
  } catch {
    throw new ConfigurationError("migration", "fix JSON syntax and use an object before previewing migration.", file);
  }
  // Explicit migration reads the original documents, including fields runtime
  // validation rejects. It never reuses a last-valid runtime source snapshot.
  const sources: LoadedSource[] = await Promise.all(
    (
      [
        ["user", getUserSettingsPath()],
        ["project", getProjectSettingsPath(cwd)],
        ["local", getLocalSettingsPath(cwd)],
        ["flag", null],
        ["policy", getManagedSettingsPath()],
      ] as const
    ).map(async ([source, sourcePath]) => ({
      source,
      path: sourcePath,
      ...(sourcePath ? await readJsonSettingsFile<Record<string, unknown>>(sourcePath) : { raw: getFlagSettings() }),
    })),
  );
  const trusted = await isProjectTrusted(cwd);
  const eligible = sources.filter(
    (source) => !["project", "local"].includes(source.source) || trusted || source.source === scope,
  );
  const originalSelectionShadowed = legacyDefaultModelIsShadowed(
    sources
      .filter((source) => ["user", "project", "local"].includes(source.source))
      .map((source) => ({ raw: source.raw, trusted: source.source === "user" || trusted })),
  );
  const savedProfileSelected = savedProfileOwnsConnection(eligible.map((source) => source.raw));
  const migration = migrateSettings(raw, {
    inheritedProfileIds: new Set(
      eligible
        .slice(
          0,
          eligible.findIndex((source) => source.source === scope),
        )
        .flatMap((source) => Object.keys((source.raw?.models as object | undefined) ?? {})),
    ),
    knownProfileIds: new Set(
      eligible.flatMap((source) => Object.keys((source.raw?.models as object | undefined) ?? {})),
    ),
    legacyEnvironment: migrateLegacyEnvironment(configurationEnvironment(), { savedProfileSelected }),
    legacyDefaultModelShadowed: originalSelectionShadowed,
    savedProfileSelected,
  });
  if (scope === "project") {
    const profiles = migration.value.models;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      for (const [id, value] of Object.entries(profiles)) {
        const apiKey = value && typeof value === "object" ? (value as Record<string, unknown>).apiKey : undefined;
        if (typeof apiKey === "string" && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(apiKey.trim())) {
          migration.notices.push({
            level: "error",
            field: `models.${id}.apiKey`,
            message:
              "Shared project profiles must use an environment reference; move the API Key to a private credential source before applying migration.",
          });
        }
      }
    }
  }
  const invalid = validateSettings(migration.value, file, { partialProfiles: true }).errors.filter(
    (message) => !message.includes("unsupported setting"),
  );
  migration.notices.push(...invalid.map((message) => ({ level: "error" as const, field: "settings", message })));
  // A new runtime may resolve the same legacy file against a different
  // connection snapshot. Approval must belong to the runtime that previewed it.
  return {
    text,
    raw,
    migration,
    revision: createHash("sha256")
      .update(revisionScope())
      .update(text)
      .update(JSON.stringify(migration.value))
      .digest("hex"),
  };
}

/** Read-only, display-safe differences. It never executes helpers or changes external secrets. */
export async function previewConfigMigration(cwd: string, scope: Scope): Promise<ConfigMigrationPreview> {
  const file = fileFor(cwd, scope);
  const { raw, migration, revision } = await readMigration(file, scope, cwd);
  const keys = new Set([...Object.keys(raw), ...Object.keys(migration.value)]);
  return {
    path: file,
    revision,
    changed: migration.changed,
    changes: [...keys]
      .filter((key) => JSON.stringify(raw[key]) !== JSON.stringify(migration.value[key]))
      .map((field) => ({
        field,
        before: raw[field] === undefined ? null : redactSettingValue(field, raw[field]),
        after: migration.value[field] === undefined ? null : redactSettingValue(field, migration.value[field]),
      })),
    notices: migration.notices,
  };
}

/** A revision binds approval to the file previewed. Backup bytes permit an exact rollback. */
export async function applyConfigMigration(
  cwd: string,
  scope: Scope,
  revision: string,
): Promise<ConfigMigrationResult> {
  const file = fileFor(cwd, scope);
  const result = await withFileLock(file, async (): Promise<ConfigMigrationResult> => {
    const { text, migration, revision: current } = await readMigration(file, scope, cwd);
    if (current !== revision)
      throw new ConfigurationError(
        "migration",
        "settings or runtime changed after preview; preview the current configuration again.",
        file,
      );
    const errors = migration.notices.filter((notice) => notice.level === "error");
    if (errors.length)
      throw new ConfigurationError(
        "migration",
        errors.map((notice) => `${notice.field}: ${notice.message}`).join(" "),
        file,
      );
    if (!migration.changed) return { changed: false, backup: null, reload: "restart" };
    const backup = `${file}.pre-standardization-${Date.now()}.bak`;
    await writePrivateFile(backup, text, { secureParent: false });
    const content = JSON.stringify(migration.value, null, 2) + "\n";
    if (scope === "project") await atomicWriteFile(file, content);
    else await writePrivateFile(file, content, { secureParent: scope === "user" });
    return { changed: true, backup, reload: "restart" };
  });
  resetSettingsCache();
  return result;
}

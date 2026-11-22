import { applyConfigMigration, previewConfigMigration, ConfigScopeSchema } from "../config/migrationFiles.js";
import { loadEnv } from "../utils/loadEnv.js";

export async function runConfigMigrationCommand(argv: string[]): Promise<number> {
  const scopeIndex = argv.indexOf("--scope");
  const scope = ConfigScopeSchema.safeParse(scopeIndex < 0 ? "user" : argv[scopeIndex + 1]);
  if (
    !scope.success ||
    argv.some((arg, index) => !["--scope", "--apply", "--json"].includes(arg) && index !== scopeIndex + 1)
  ) {
    console.error("Usage: eagent config migrate [--scope user|project|local] [--apply] [--json]");
    return 1;
  }
  try {
    await loadEnv(process.cwd());
    const preview = await previewConfigMigration(process.cwd(), scope.data);
    const result = argv.includes("--apply")
      ? await applyConfigMigration(process.cwd(), scope.data, preview.revision)
      : undefined;
    if (argv.includes("--json")) console.log(JSON.stringify({ preview, ...(result ? { result } : {}) }));
    else {
      console.log(`Configuration migration: ${preview.path}`);
      for (const change of preview.changes)
        console.log(`${change.field}:\n  ${JSON.stringify(change.before)}\n→ ${JSON.stringify(change.after)}`);
      for (const notice of preview.notices) console.log(`[${notice.level}] ${notice.field}: ${notice.message}`);
      console.log(
        result?.changed
          ? `Applied. Backup: ${result.backup}\nRebuild the runtime to load the migrated environment.`
          : preview.changed
            ? "Preview only. Use --apply to back up and migrate this file."
            : "Already canonical; no changes.",
      );
    }
    return preview.notices.some((notice) => notice.level === "error") ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Migration failed.";
    if (argv.includes("--json")) console.log(JSON.stringify({ error: { code: "configuration", message } }));
    else console.error(message);
    return 1;
  }
}

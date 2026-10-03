/**
 * Output styles startup orchestration.
 *
 * Called once from the CLI entrypoint before the React UI mounts:
 *   1. Load custom styles from disk and merge them into the registry.
 *   2. Read the persisted `outputStyle` preference (user + project
 *      settings.json) and make it the active style if it resolves.
 *
 * Mirrors the shape of services/skills/bootstrap.ts so the entrypoint can
 * fire-and-forget every subsystem with the same idiom.
 */

import { readMergedStringSetting } from "../utils/settings.js";
import { loadAllOutputStyles } from "./loadOutputStylesDir.js";
import {
  getActiveOutputStyleName,
  resolveOutputStyle,
  setActiveOutputStyle,
  setCustomOutputStyles,
} from "./registry.js";

export interface OutputStylesBootstrapResult {
  /** Total styles registered (built-in + custom). */
  styleCount: number;
  /** Custom styles loaded from disk. */
  customCount: number;
  /** The active style after applying the persisted preference. */
  activeStyle: string;
  warnings: string[];
}

export async function bootstrapOutputStyles(cwd: string): Promise<OutputStylesBootstrapResult> {
  const { styles, warnings } = await loadAllOutputStyles(cwd);
  setCustomOutputStyles(styles);

  // Apply the persisted default style, if any and if it resolves to a
  // known style. An unknown persisted value (e.g. a custom style whose
  // file was deleted) silently falls back to `default`.
  const persisted = await readMergedStringSetting(cwd, "outputStyle").catch(() => undefined);
  if (persisted && resolveOutputStyle(persisted)) {
    setActiveOutputStyle(persisted);
  }

  for (const warning of warnings) {
    console.warn(`[easy-agent] ${warning}`);
  }

  return {
    styleCount: styles.length + 3, // +3 built-ins (default/Explanatory/Learning)
    customCount: styles.length,
    activeStyle: getActiveOutputStyleName(),
    warnings,
  };
}

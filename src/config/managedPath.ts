/**
 * Resolves the path to a machine-wide managed settings file.
 *
 * This is the highest-priority configuration source — intended for managed
 * deployments where an administrator pins settings outside any single user's
 * control. Only a single local file is consulted here; richer managed-config
 * backends (remote sync, OS policy stores) are reserved extension points and
 * not wired up.
 *
 * Paths follow the platform conventions for system-wide application data:
 *   macOS   → /Library/Application Support/EasyAgent/managed-settings.json
 *   Linux   → /etc/easy-agent/managed-settings.json
 *   Windows → %PROGRAMDATA%\EasyAgent\managed-settings.json
 */

import * as path from "node:path";

export function getManagedSettingsPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/EasyAgent/managed-settings.json";
    case "win32": {
      const programData = process.env.PROGRAMDATA || "C:\\ProgramData";
      return path.join(programData, "EasyAgent", "managed-settings.json");
    }
    default:
      return "/etc/easy-agent/managed-settings.json";
  }
}

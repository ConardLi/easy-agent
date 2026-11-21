/** Acquire the single API Key for an already selected, trusted profile. */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ConfigurationError } from "../../config/values.js";

const execAsync = promisify(exec);

export async function resolveApiKeyFromHelper(
  cwd: string,
  helper: string,
  profileId: string,
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  try {
    const { stdout } = await execAsync(helper, {
      cwd,
      env: { ...env },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      ...(process.platform !== "win32" ? { shell: env.SHELL || "/bin/sh" } : {}),
    });
    const apiKey = stdout.trim();
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("Invalid helper output");
    return apiKey;
  } catch {
    // Never include command, stderr, stdout, or the execution exception.
    throw new ConfigurationError(
      `models.${profileId}.apiKey.helper`,
      "helper failed or returned an empty/invalid API Key; repair this source and retry.",
    );
  }
}

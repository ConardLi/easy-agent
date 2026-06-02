/**
 * apiKeyHelper — resolve an API token by running a user-configured script.
 *
 * Some environments don't keep a static token in the environment; instead a
 * short-lived token is minted by a helper (vault CLI, cloud auth, etc.). The
 * `apiKeyHelper` setting points at such a script; we run it and use its stdout
 * as the bearer token.
 *
 * Security: the helper is EXECUTED, so it is read only from TRUSTED settings
 * sources (user / flag / policy, plus project/local once the folder is
 * trusted). An untrusted repo can't silently run a script or redirect auth.
 *
 * Precedence: an explicit `ANTHROPIC_AUTH_TOKEN` in the environment always
 * wins; the helper only fills in a token when none is set.
 *
 * Reference: source code's `apiKeyHelper` in the settings schema + its
 * credential resolution path.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readTrustedStringSetting } from "../../utils/settings.js";

const execAsync = promisify(exec);

const HELPER_TIMEOUT_MS = 10_000;

/**
 * Run the configured `apiKeyHelper` script and return its trimmed stdout as a
 * token. Returns null when no helper is configured, when it produces no
 * output, or when it fails (the caller falls back to the env token / SDK
 * default — a broken helper must not crash startup).
 */
export async function resolveApiKeyFromHelper(cwd: string): Promise<string | null> {
  const helper = await readTrustedStringSetting(cwd, "apiKeyHelper").catch(() => undefined);
  if (!helper) return null;

  try {
    const { stdout } = await execAsync(helper, {
      cwd,
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      shell: process.env.SHELL || "/bin/bash",
    });
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

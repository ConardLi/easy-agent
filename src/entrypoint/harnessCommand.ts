/**
 * `eagent harness show [name|file] [--json]` and `eagent harness diff <a> <b> [--json]`.
 *
 * Read-only. The workspace environment is loaded the way a session loads it
 * (settings `env` and `.env` for a trusted workspace), so environment-backed
 * values match what a session would see.
 */

import { trustProjectForSession } from "../config/globalState.js";
import { listBuiltInComponents } from "../harness/components.js";
import { diffHarnesses } from "../harness/diff.js";
import { formatHarness, formatHarnessDiff } from "../harness/format.js";
import { type ResolvedHarness, resolveHarness } from "../harness/resolve.js";
import { harnessTarget } from "../harness/target.js";
import { loadEnv } from "../utils/loadEnv.js";

const USAGE = `Usage:
  eagent harness show [name|file] [--json]   Resolve an Agent and show every setting and where it comes from
  eagent harness diff <a> <b> [--json]       Compare the resolved settings of two Agents
  An argument with a path separator or a .json suffix is read as a spec file.
  --trust-project-config trusts project settings for this invocation.`;

async function resolveArgument(argument: string | undefined, cwd: string): Promise<ResolvedHarness> {
  if (argument === undefined) return resolveHarness({ cwd });
  const target = await harnessTarget(argument, cwd);
  return resolveHarness({ cwd, ...target });
}

const hasErrors = (...resolved: ResolvedHarness[]) =>
  resolved.some((harness) => harness.issues.some((issue) => issue.level === "error"));

export async function runHarnessCommand(args: readonly string[], cwd = process.cwd()): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [subcommand, ...rest] = positional;
  if (args.includes("--trust-project-config")) await trustProjectForSession(cwd);

  try {
    if (subcommand === "show" && rest.length <= 1) {
      await loadEnv(cwd);
      const resolved = await resolveArgument(rest[0], cwd);
      const components = listBuiltInComponents(resolved);
      process.stdout.write(
        json
          ? `${JSON.stringify({ harness: resolved, components }, null, 2)}\n`
          : `${formatHarness(resolved, components)}\n`,
      );
      return hasErrors(resolved) ? 1 : 0;
    }
    if (subcommand === "diff" && rest.length === 2) {
      await loadEnv(cwd);
      const [a, b] = await Promise.all([resolveArgument(rest[0], cwd), resolveArgument(rest[1], cwd)]);
      const diff = diffHarnesses(a, b);
      process.stdout.write(json ? `${JSON.stringify(diff, null, 2)}\n` : `${formatHarnessDiff(diff)}\n`);
      for (const issue of [...a.issues, ...b.issues].filter((entry) => entry.level === "error")) {
        process.stderr.write(`[easy-agent] ${issue.harness ? `Agent "${issue.harness}": ` : ""}${issue.message}\n`);
      }
      return hasErrors(a, b) ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`[easy-agent] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

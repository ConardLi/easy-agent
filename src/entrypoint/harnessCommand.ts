/**
 * `eagent harness list [--json]`, `eagent harness show [name|file] [--json]`,
 * and `eagent harness diff <a> <b> [--prompt <text>] [--json]`.
 *
 * Read-only. The workspace environment is loaded the way a session loads it
 * (settings `env` and `.env` for a trusted workspace), so environment-backed
 * values match what a session would see. `diff --prompt` starts a runtime
 * with `<a>`'s Agent, as a session would (MCP servers included), and renders
 * the first request of each Agent without sending it.
 */

import { trustProjectForSession } from "../config/globalState.js";
import { listBuiltInComponents } from "../harness/components.js";
import { diffHarnesses } from "../harness/diff.js";
import { formatHarness, formatHarnessDiff, formatHarnessList, formatRequestDiff } from "../harness/format.js";
import { listHarnesses } from "../harness/manage.js";
import { type ResolvedHarness, resolveHarness } from "../harness/resolve.js";
import { type HarnessTarget, harnessTarget } from "../harness/target.js";
import { loadEnv } from "../utils/loadEnv.js";

const USAGE = `Usage:
  eagent harness list [--json]               List the Agents and this workspace's default Agent
  eagent harness show [name|file] [--json]   Resolve an Agent and show every setting and where it comes from
  eagent harness diff <a> <b> [--json]       Compare the resolved settings of two Agents
  eagent harness diff <a> <b> --prompt <text> [--json]
                                             Also compare the first request each Agent renders for <text>;
                                             no model is called and no tool runs
  An argument with a path separator or a .json suffix is read as a spec file.
  --trust-project-config trusts project settings for this invocation.`;

async function resolveArgument(argument: string | undefined, cwd: string): Promise<ResolvedHarness> {
  if (argument === undefined) return resolveHarness({ cwd });
  const target = await harnessTarget(argument, cwd);
  return resolveHarness({ cwd, ...target });
}

const hasErrors = (...resolved: ResolvedHarness[]) =>
  resolved.some((harness) => harness.issues.some((issue) => issue.level === "error"));

interface ParsedArgs {
  positional: string[];
  json: boolean;
  trust: boolean;
  prompt?: string;
}

/** Flags and positional arguments; `--prompt` takes the next argument (or `--prompt=<text>`). */
function parseArgs(args: readonly string[]): ParsedArgs | null {
  const parsed: ParsedArgs = { positional: [], json: false, trust: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--trust-project-config") parsed.trust = true;
    else if (arg === "--prompt") {
      const value = args[++index];
      if (value === undefined) return null;
      parsed.prompt = value;
    } else if (arg.startsWith("--prompt=")) parsed.prompt = arg.slice("--prompt=".length);
    else if (!arg.startsWith("--")) parsed.positional.push(arg);
  }
  return parsed;
}

const stderrLogger = {
  warn: (message: string) => process.stderr.write(`${message}\n`),
  error: (message: string) => process.stderr.write(`${message}\n`),
};

/** The settings diff and the request diff of two Agents for a prompt, rendered in a runtime of `<a>`. */
async function diffWithPrompt(a: HarnessTarget, b: HarnessTarget, prompt: string, cwd: string, trust: boolean) {
  const { createAgentRuntime } = await import("../sdk/runtime.js");
  const runtime = await createAgentRuntime({
    cwd,
    ...(trust ? { trust: "session" as const } : {}),
    hardenPrivateData: false,
    services: { mcpServers: true, wait: true },
    logger: stderrLogger,
    harness: "spec" in a ? { spec: a.spec } : { name: a.name },
  });
  try {
    return await runtime.diffHarness(
      "spec" in a ? { spec: a.spec } : { name: a.name },
      "spec" in b ? { spec: b.spec } : { name: b.name },
      { prompt },
    );
  } finally {
    await runtime.dispose();
  }
}

export async function runHarnessCommand(args: readonly string[], cwd = process.cwd()): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const { json, prompt } = parsed;
  const [subcommand, ...rest] = parsed.positional;
  if (parsed.trust) await trustProjectForSession(cwd);
  if (prompt !== undefined && subcommand !== "diff") {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  try {
    if (subcommand === "list" && rest.length === 0) {
      const listing = await listHarnesses(cwd);
      process.stdout.write(json ? `${JSON.stringify(listing, null, 2)}\n` : `${formatHarnessList(listing)}\n`);
      return 0;
    }
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
      const targets = await Promise.all([harnessTarget(rest[0]!, cwd), harnessTarget(rest[1]!, cwd)]);
      const [a, b] = await Promise.all(targets.map((target) => resolveHarness({ cwd, ...target })));
      for (const issue of [...a!.issues, ...b!.issues].filter((entry) => entry.level === "error")) {
        process.stderr.write(`[easy-agent] ${issue.harness ? `Agent "${issue.harness}": ` : ""}${issue.message}\n`);
      }
      if (prompt === undefined || hasErrors(a!, b!)) {
        const diff = diffHarnesses(a!, b!);
        process.stdout.write(json ? `${JSON.stringify(diff, null, 2)}\n` : `${formatHarnessDiff(diff)}\n`);
        return hasErrors(a!, b!) ? 1 : 0;
      }
      const diff = await diffWithPrompt(targets[0]!, targets[1]!, prompt, cwd, parsed.trust);
      process.stdout.write(
        json
          ? `${JSON.stringify(diff, null, 2)}\n`
          : `${formatHarnessDiff(diff)}\n\n${diff.request ? formatRequestDiff(diff.request) : ""}\n`,
      );
      return 0;
    }
  } catch (error) {
    process.stderr.write(`[easy-agent] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

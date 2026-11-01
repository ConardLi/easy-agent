/**
 * `/harness [name|file]` and `/harness diff <a> <b>`: the same views as
 * `eagent harness`. Without an argument, the Agent this session runs.
 */

import { harnessFor } from "../../../harness/active.js";
import { listBuiltInComponents } from "../../../harness/components.js";
import { diffHarnesses } from "../../../harness/diff.js";
import { formatHarness, formatHarnessDiff } from "../../../harness/format.js";
import { type ResolvedHarness, resolveHarness } from "../../../harness/resolve.js";
import { harnessTarget } from "../../../harness/target.js";
import type { QueryEngineEvent } from "../types.js";
import type { CommandContext } from "./context.js";

async function resolveArgument(argument: string | undefined, cwd: string): Promise<ResolvedHarness> {
  if (argument === undefined) return harnessFor(cwd, { current: true });
  return resolveHarness({ cwd, ...(await harnessTarget(argument, cwd)) });
}

export async function* handleHarnessCommand(
  ctx: CommandContext,
  args: string[],
): AsyncGenerator<QueryEngineEvent, { handled: boolean }> {
  try {
    if (args[0] === "diff") {
      if (args.length !== 3) {
        yield { type: "command", kind: "error", message: "Usage: /harness diff <a> <b>" };
        return { handled: true };
      }
      const [a, b] = await Promise.all([resolveArgument(args[1], ctx.cwd), resolveArgument(args[2], ctx.cwd)]);
      yield { type: "command", kind: "info", message: formatHarnessDiff(diffHarnesses(a, b)) };
      return { handled: true };
    }
    if (args.length > 1) {
      yield { type: "command", kind: "error", message: "Usage: /harness [name|file] or /harness diff <a> <b>" };
      return { handled: true };
    }
    const resolved = await resolveArgument(args[0], ctx.cwd);
    yield { type: "command", kind: "info", message: formatHarness(resolved, listBuiltInComponents(resolved)) };
  } catch (error) {
    yield { type: "command", kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  return { handled: true };
}

/**
 * Workspace bootstrap: everything that must happen before the first session
 * of a workspace runs.
 *
 * It runs in two steps so a caller can stop after the first one:
 *   - `loadWorkspace` settles trust, loads the environment, resolves and
 *     installs the Agent's settings, and fills the registries the system
 *     prompt is built from (skills, agents, output styles, commands,
 *     plugins), then reports sandbox availability. This is all
 *     `--dump-system-prompt` needs, and it executes no workspace code.
 *   - `activateWorkspace` applies the execution-affecting settings: the API
 *     key helper (which runs a configured command), extra file roots, session
 *     retention, and the hook kill switch.
 *
 * Warnings and bootstrap failures go to the logger in the order they occur.
 */

import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { bootstrapAgents } from "../agents/bootstrap.js";
import { bootstrapUserCommands } from "../commands/userCommands/bootstrap.js";
import { isProjectTrusted, trustProjectForSession } from "../config/globalState.js";
import { setFlagSettings } from "../config/sources.js";
import { detectWorkspaceRisks } from "../config/workspaceRisks.js";
import { activeHarness, installHarness } from "../harness/active.js";
import { type HarnessIssue, harnessEnvironment, type ResolvedHarness, resolveHarness } from "../harness/resolve.js";
import { unmatchedSelectionEntries } from "../harness/selection.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import { getSandboxCapability, getSandboxUnavailableReason, loadSandboxSettings } from "../sandbox/index.js";
import { resolveApiKeyFromHelper } from "../services/api/apiKeyHelper.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { cleanupOldFileHistoryBackups } from "../session/fileHistory.js";
import { applySessionRetentionPolicy } from "../session/storage.js";
import { bootstrapOutputStyles } from "../styles/bootstrap.js";
import { getRegisteredTools } from "../tools/index.js";
import { setAdditionalAllowedRoots } from "../tools/pathUtils.js";
import { loadEnv } from "../utils/loadEnv.js";
import { logWarn } from "../utils/log.js";
import { hardenPrivateDataStorage } from "../utils/privateData.js";
import { readTrustedStringArraySetting } from "../utils/settings.js";
import { AgentSdkError } from "./errors.js";
import type { AgentRuntimeOptions, RuntimeLogger } from "./types.js";

export interface WorkspaceReport {
  projectTrusted: boolean;
  /** Project configuration ignored because the workspace is not trusted. */
  ignoredProjectConfig: string[];
  /** Project `.env` credential overrides ignored in favor of the parent environment. */
  ignoredCredentialOverrides: number;
  /** Why OS sandboxing is unavailable, when it is. */
  sandboxUnavailableReason: string | null;
}

export const consoleLogger: RuntimeLogger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const errorMessage = (error: unknown): string => (error as Error).message;

function describeIssue(issue: HarnessIssue): string {
  const where = issue.harness && !issue.message.includes(`"${issue.harness}"`) ? `Agent "${issue.harness}"` : "";
  const at = issue.path ? `${where ? " " : ""}${issue.path}` : "";
  return `${where}${at}${where || at ? ": " : ""}${issue.message}`;
}

/** The errors of a resolved Agent as one line, or undefined when it has none. */
function agentErrors(resolved: ResolvedHarness): string | undefined {
  const errors = resolved.issues.filter((issue) => issue.level === "error");
  return errors.length > 0 ? errors.map(describeIssue).join("; ") : undefined;
}

export async function loadWorkspace(options: AgentRuntimeOptions): Promise<WorkspaceReport> {
  const { cwd } = options;
  const logger = options.logger ?? consoleLogger;
  const target = options.harness ?? {};
  if (target.name !== undefined && target.spec !== undefined) {
    throw new AgentSdkError("invalid_argument", "Select an Agent by name or by spec, not both.");
  }

  if (options.hardenPrivateData !== false) {
    const privateDataReport = await hardenPrivateDataStorage({ projectCwd: cwd });
    const first = privateDataReport.issues[0];
    if (first) {
      logger.warn(
        `[easy-agent] ⚠ Could not fully protect local data: ${first.path}: ${first.message}. Run /doctor for details.`,
      );
    }
  }
  if (options.flagSettings) setFlagSettings({ ...options.flagSettings });
  if (options.trust === "session") await trustProjectForSession(cwd);

  // Trust is settled before anything project-controlled is read.
  const projectTrusted = await isProjectTrusted(cwd);
  const environmentReport = await loadEnv(cwd);

  // The Agent's settings, resolved once the environment is loaded; the
  // runtime and everything after it read them from the installed snapshot.
  // Environment variables are taken now; settings files are read again on
  // each refresh.
  const env = harnessEnvironment();
  const selection =
    target.spec !== undefined ? { spec: target.spec } : target.name !== undefined ? { name: target.name } : {};
  const selected = "spec" in selection || "name" in selection;
  // A selected Agent that stops resolving (its definition was edited or
  // removed) keeps its last good settings; the problem is reported once.
  let running = false;
  let reported: string | undefined;
  const resolver = {
    cwd,
    resolve: async (dir: string) => {
      const resolved = await resolveHarness({ cwd: dir, env, ...selection });
      const problem = selected ? agentErrors(resolved) : undefined;
      if (problem === undefined) {
        if (nodePath.resolve(dir) === nodePath.resolve(cwd)) reported = undefined;
        return resolved;
      }
      if (running && problem !== reported) {
        reported = problem;
        logWarn(`The selected Agent no longer resolves (${problem}); keeping its previous settings.`);
      }
      throw new AgentSdkError("harness", `The selected Agent does not resolve: ${problem}`);
    },
  };
  if (selected) {
    // Running another Agent than the one asked for would be wrong, so a
    // selected Agent that does not resolve stops the startup.
    const resolved = await resolver.resolve(cwd);
    installHarness(resolved, resolver);
    for (const issue of resolved.issues) logger.warn(`[easy-agent] ⚠ ${describeIssue(issue)}`);
  } else {
    try {
      installHarness(await resolver.resolve(cwd), resolver);
    } catch (error) {
      installHarness(null, resolver);
      logger.warn(
        `[easy-agent] ⚠ Could not resolve Agent settings: ${errorMessage(error)}. Using environment variables and built-in defaults.`,
      );
    }
  }
  running = true;
  // MCP tools are not known until their servers connect, so only built-in names are checked.
  const unknownTools = unmatchedSelectionEntries(
    activeHarness(),
    "tools",
    getRegisteredTools().map((tool) => tool.name),
  ).filter((entry) => !entry.startsWith("mcp__"));
  if (unknownTools.length > 0) {
    logger.warn(`[easy-agent] ⚠ tools.include and tools.exclude name no built-in tool: ${unknownTools.join(", ")}`);
  }

  let ignoredProjectConfig: string[] = [];
  if (!projectTrusted) {
    ignoredProjectConfig = await detectWorkspaceRisks(cwd);
    if (ignoredProjectConfig.length > 0) {
      logger.warn(
        `[easy-agent] Project configuration ignored in this untrusted workspace: ${ignoredProjectConfig.join(", ")}. ` +
          "Use --trust-project-config to allow it for this invocation.",
      );
    }
  }

  const ignoredCredentialOverrides = Object.values(environmentReport.protectedCredentialOverrides).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );
  if (ignoredCredentialOverrides > 0) {
    logger.warn(
      `[easy-agent] Ignored ${ignoredCredentialOverrides} project credential environment override(s); ` +
        "credentials inherited from the parent process take precedence.",
    );
  }

  // The system prompt lists skills, sub-agent types, the output style, and
  // commands, so every registry is filled before any prompt is rendered.
  await bootstrapSkills(cwd).catch((error) => {
    logger.error(`[easy-agent] skills bootstrap failed: ${errorMessage(error)}`);
  });
  await bootstrapAgents(cwd).catch((error) => {
    logger.error(`[easy-agent] agents bootstrap failed: ${errorMessage(error)}`);
  });
  await bootstrapOutputStyles(cwd).catch((error) => {
    logger.error(`[easy-agent] output-styles bootstrap failed: ${errorMessage(error)}`);
  });
  await bootstrapUserCommands(cwd).catch((error) => {
    logger.error(`[easy-agent] commands bootstrap failed: ${errorMessage(error)}`);
  });
  // Plugins layer their components on top of the base registries, so they
  // load last. Their MCP servers start later with the other services.
  await refreshActivePlugins(cwd, { pluginDirs: [...(options.pluginDirs ?? [])], applyMcp: false }).catch((error) => {
    logger.error(`[easy-agent] plugins bootstrap failed: ${errorMessage(error)}`);
  });

  // Resolve the sandbox capability before the first shell command so an
  // unavailable security boundary is visible at startup.
  let sandboxUnavailableReason: string | null = null;
  try {
    const sandboxSettings = await loadSandboxSettings(cwd);
    const capability = getSandboxCapability();
    const reason = getSandboxUnavailableReason(sandboxSettings.enabled);
    if (reason) {
      sandboxUnavailableReason = reason;
      logger.warn(
        `[easy-agent] ⚠ Sandbox unavailable: ${reason}. ` +
          (sandboxSettings.failClosed
            ? "Shell commands that require the sandbox will be blocked."
            : "Shell commands will require normal permission checks and may run unsandboxed."),
      );
    } else if (sandboxSettings.enabled && capability.warnings.length > 0) {
      logger.warn(`[easy-agent] ⚠ Sandbox warnings: ${capability.warnings.join("; ")}`);
    }
  } catch (error) {
    sandboxUnavailableReason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[easy-agent] ⚠ ${sandboxUnavailableReason} ` +
        "Shell commands will be blocked until the sandbox configuration is valid.",
    );
  }

  return { projectTrusted, ignoredProjectConfig, ignoredCredentialOverrides, sandboxUnavailableReason };
}

export async function activateWorkspace(options: AgentRuntimeOptions): Promise<void> {
  const { cwd } = options;

  // apiKeyHelper mints an auth token by running a configured command, only
  // when the environment does not already provide one.
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    const token = await resolveApiKeyFromHelper(cwd);
    if (token) process.env.ANTHROPIC_AUTH_TOKEN = token;
  }

  // additionalDirectories widens the file-tool boundary; trusted sources only.
  const extraRoots = await readTrustedStringArraySetting(cwd, "additionalDirectories").catch(() => []);
  setAdditionalAllowedRoots(
    extraRoots.map((dir) => nodePath.resolve(cwd, dir.startsWith("~") ? dir.replace("~", nodeOs.homedir()) : dir)),
  );

  // cleanupPeriodDays prunes old transcripts and file-history backups, or
  // disables persistence entirely.
  await applySessionRetentionPolicy(cwd).catch(() => {});
  await cleanupOldFileHistoryBackups(cwd).catch(() => {});

  // The hook kill switch is read on hot paths, so it is snapshotted here.
  await refreshHookDisableFromSettings(cwd).catch(() => {});
}

/**
 * Workspace bootstrap: everything that must happen before the first session
 * of a workspace runs.
 *
 * It runs in two steps so a caller can stop after the first one:
 *   - `loadWorkspace` settles trust, loads the environment, and fills the
 *     registries the system prompt is built from (skills, agents, output
 *     styles, commands, plugins), then reports sandbox availability. This is
 *     all `--dump-system-prompt` needs, and it executes no workspace code.
 *   - `activateWorkspace` applies the execution-affecting settings: the API
 *     key helper (which runs a configured command), extra file roots, session
 *     retention, the hook kill switch, and thinking defaults.
 *
 * Warnings and bootstrap failures go to the logger in the order they occur.
 */

import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { bootstrapAgents } from "../agents/bootstrap.js";
import { bootstrapUserCommands } from "../commands/userCommands/bootstrap.js";
import { isProjectTrusted, trustProjectForSession } from "../config/globalState.js";
import { getScalarSetting, loadTrustedSettingSources, setFlagSettings } from "../config/sources.js";
import { detectWorkspaceRisks } from "../config/workspaceRisks.js";
import { refreshHookDisableFromSettings } from "../hooks/settings.js";
import { refreshActivePlugins } from "../plugins/runtime.js";
import { getSandboxCapability, getSandboxUnavailableReason, loadSandboxSettings } from "../sandbox/index.js";
import { resolveApiKeyFromHelper } from "../services/api/apiKeyHelper.js";
import { bootstrapSkills } from "../services/skills/bootstrap.js";
import { cleanupOldFileHistoryBackups } from "../session/fileHistory.js";
import { applySessionRetentionPolicy } from "../session/storage.js";
import { bootstrapOutputStyles } from "../styles/bootstrap.js";
import { setAdditionalAllowedRoots } from "../tools/pathUtils.js";
import { loadEnv } from "../utils/loadEnv.js";
import { hardenPrivateDataStorage } from "../utils/privateData.js";
import { readTrustedStringArraySetting } from "../utils/settings.js";
import { configureThinkingDefaults, type EffortLevel } from "../utils/thinking.js";
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

export async function loadWorkspace(options: AgentRuntimeOptions): Promise<WorkspaceReport> {
  const { cwd } = options;
  const logger = options.logger ?? consoleLogger;

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

  // Thinking defaults: alwaysThinkingEnabled and effortLevel from settings.
  try {
    const sources = await loadTrustedSettingSources(cwd);
    const alwaysThinkingEnabled = getScalarSetting<boolean>(sources, "alwaysThinkingEnabled", {
      predicate: (v) => typeof v === "boolean",
    });
    const effortLevel = getScalarSetting<string>(sources, "effortLevel", {
      predicate: (v) => v === "low" || v === "medium" || v === "high" || v === "max",
    });
    configureThinkingDefaults({
      ...(alwaysThinkingEnabled !== undefined ? { alwaysThinkingEnabled } : {}),
      ...(effortLevel !== undefined ? { effortLevel: effortLevel as EffortLevel } : {}),
    });
  } catch {
    // Non-fatal: thinking falls back to its adaptive default.
  }
}

import { randomUUID } from "node:crypto";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getSandboxCapability } from "./availability.js";
import type { SandboxBackend, SandboxProfile } from "./types.js";
import { annotateStderrWithSandboxFailures } from "./violations.js";

export class SandboxInitializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxInitializationError";
  }
}

export interface SandboxedCommand {
  argv: string[];
  env: NodeJS.ProcessEnv;
  commandId: string;
  backend: SandboxBackend;
  cleanup(): void;
}

let initialized = false;
let initialization: Promise<void> | null = null;
let activeConfigSignature = "";
let leaseTail = Promise.resolve();

// Called only after explicit deny/allow rules. The runtime's resolved-address
// guard still rejects loopback, link-local, metadata, and other protected IPs.
const allowUnlistedPublicDestination = async (): Promise<boolean> => true;

async function acquireRuntimeLease(): Promise<() => void> {
  const previous = leaseTail;
  let releaseNext!: () => void;
  leaseTail = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext();
  };
}

export function toSandboxRuntimeConfig(profile: SandboxProfile): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: profile.filesystem.allowWrite,
      denyWrite: profile.filesystem.denyWrite,
      allowRead: profile.filesystem.allowRead,
      denyRead: profile.filesystem.denyRead,
    },
    network: {
      allowedDomains: profile.network.allowedDomains,
      deniedDomains: profile.network.deniedDomains,
      allowUnixSockets: profile.network.allowUnixSockets,
      allowAllUnixSockets: profile.network.allowAllUnixSockets,
      allowLocalBinding: profile.network.allowLocalBinding,
      strictAllowlist: profile.network.allowedDomains.length > 0,
    },
  };
}

async function initialize(config: SandboxRuntimeConfig, signature: string): Promise<void> {
  try {
    await SandboxManager.initialize(
      config,
      allowUnlistedPublicDestination,
      process.platform === "darwin",
    );
    initialized = true;
    activeConfigSignature = signature;
  } catch (error) {
    initialized = false;
    activeConfigSignature = "";
    await SandboxManager.reset().catch(() => {});
    throw new SandboxInitializationError(
      `sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    initialization = null;
  }
}

async function ensureInitialized(profile: SandboxProfile): Promise<void> {
  const config = toSandboxRuntimeConfig(profile);
  const signature = JSON.stringify(config);
  if (initialization) await initialization;
  if (!initialized) {
    initialization = initialize(config, signature);
    await initialization;
    return;
  }
  if (signature !== activeConfigSignature) {
    try {
      SandboxManager.updateConfig(config);
      activeConfigSignature = signature;
    } catch (error) {
      throw new SandboxInitializationError(
        `sandbox configuration update failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

export async function wrapWithSandbox(params: {
  command: string;
  cwd: string;
  profile: SandboxProfile;
  shell?: string;
  abortSignal?: AbortSignal;
  commandId?: string;
}): Promise<SandboxedCommand> {
  const releaseLease = await acquireRuntimeLease();
  try {
    if (params.abortSignal?.aborted) {
      throw new SandboxInitializationError("sandbox command preparation was aborted");
    }
    const capability = getSandboxCapability();
    if (!capability.available || !capability.backend) {
      throw new SandboxInitializationError(
        `sandbox unavailable: ${capability.errors.join("; ") || capability.platform}`,
      );
    }
    await ensureInitialized(params.profile);
    const commandId = params.commandId ?? randomUUID();
    const descriptor = await SandboxManager.wrapWithSandboxArgv(
      params.command,
      params.shell ?? process.env.SHELL ?? "/bin/bash",
      undefined,
      params.abortSignal,
      params.cwd,
      { commandId, commandText: params.command },
    );
    let cleaned = false;
    return {
      argv: descriptor.argv,
      env: descriptor.env,
      commandId,
      backend: capability.backend,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        try {
          SandboxManager.cleanupAfterCommand();
        } catch {
          // Runtime reset and process-exit cleanup remain as safety nets.
        } finally {
          releaseLease();
        }
      },
    };
  } catch (error) {
    try {
      SandboxManager.cleanupAfterCommand();
    } catch {}
    releaseLease();
    if (error instanceof SandboxInitializationError) throw error;
    throw new SandboxInitializationError(
      `sandbox command preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function annotateSandboxFailure(
  commandId: string,
  stderr: string,
  exitCode: number | null,
): string {
  const runtimeAnnotated = SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
  return annotateStderrWithSandboxFailures(runtimeAnnotated, exitCode);
}

export function cleanupSandboxCommand(command: SandboxedCommand): void {
  command.cleanup();
}

export async function resetSandboxRuntime(): Promise<void> {
  const releaseLease = await acquireRuntimeLease();
  try {
    initialized = false;
    initialization = null;
    activeConfigSignature = "";
    await SandboxManager.reset();
  } finally {
    releaseLease();
  }
}

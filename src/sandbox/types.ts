export interface SandboxFilesystemSettings {
  allowWrite?: string[];
  denyWrite?: string[];
  allowRead?: string[];
  denyRead?: string[];
}

export interface SandboxNetworkSettings {
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
}

export interface SandboxSettings {
  enabled?: boolean;
  /** Block command execution when the requested sandbox cannot be applied. */
  failClosed?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
  filesystem?: SandboxFilesystemSettings;
  network?: SandboxNetworkSettings;
}

export interface SandboxProfile {
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    allowRead: string[];
    denyRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
    allowLocalBinding: boolean;
  };
}

export type SandboxBackend = "seatbelt" | "bubblewrap";

export interface SandboxCapability {
  platform: NodeJS.Platform;
  backend: SandboxBackend | null;
  supported: boolean;
  available: boolean;
  errors: string[];
  warnings: string[];
}

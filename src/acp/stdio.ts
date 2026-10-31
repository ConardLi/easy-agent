/** Runs the ACP agent on this process's stdin and stdout. */

import { serveOverStdio } from "../jsonrpc/stdio.js";
import { createAgentRuntime, type HarnessTarget } from "../sdk/index.js";
import { AcpAgent } from "./agent.js";

export interface RunAcpOptions {
  version: string;
  pluginDirs: readonly string[];
  trustWorkspace: boolean;
  /** `--harness`: the Agent the editor's sessions use. */
  harness?: HarnessTarget;
}

export function runAcpOverStdio(options: RunAcpOptions): Promise<never> {
  return serveOverStdio(
    (connection) =>
      new AcpAgent({
        ...options,
        send: connection.send,
        logError: connection.logError,
        createRuntime: createAgentRuntime,
      }),
  );
}

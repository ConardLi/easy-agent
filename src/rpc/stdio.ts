/** Runs the RPC server on this process's stdin and stdout. */

import { serveOverStdio } from "../jsonrpc/stdio.js";
import { createAgentRuntime, type HarnessTarget } from "../sdk/index.js";
import { RpcServer } from "./server.js";

export interface RunRpcOptions {
  cwd: string;
  pluginDirs: readonly string[];
  version: string;
  /** `--harness`: the Agent used when `initialize` names none. */
  harness?: HarnessTarget;
}

export function runRpcOverStdio(options: RunRpcOptions): Promise<never> {
  return serveOverStdio(
    (connection) =>
      new RpcServer({
        ...options,
        send: connection.send,
        onShutdown: connection.exit,
        createRuntime: createAgentRuntime,
        logError: connection.logError,
      }),
  );
}

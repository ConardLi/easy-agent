/** Runs the RPC server on this process's stdin and stdout. */

import { serveOverStdio } from "../jsonrpc/stdio.js";
import { createAgentRuntime } from "../sdk/index.js";
import { RpcServer } from "./server.js";

export interface RunRpcOptions {
  cwd: string;
  pluginDirs: readonly string[];
  version: string;
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

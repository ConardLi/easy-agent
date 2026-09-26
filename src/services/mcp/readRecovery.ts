import type { ConnectedMcpServer } from "../../types/mcp.js";
import { requestMcpReconnect } from "./client.js";

export async function withMcpReadRecovery<T>(
  server: ConnectedMcpServer,
  read: (current: ConnectedMcpServer) => Promise<T>,
): Promise<T> {
  try {
    return await read(server);
  } catch (error) {
    if (server.config.type !== "http" || !server.sessionId?.() || (error as { code?: number }).code !== 404) throw error;
    const rebuilt = await requestMcpReconnect(server.name);
    if (rebuilt?.type !== "connected") throw error;
    return read(rebuilt);
  }
}

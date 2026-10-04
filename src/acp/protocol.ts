/**
 * The parts of Agent Client Protocol v1 this agent accepts, as zod schemas
 * for validating what clients send. Unknown fields are ignored.
 *
 * https://agentclientprotocol.com/protocol/v1/overview
 */

import { z } from "zod";

export const ACP_PROTOCOL_VERSION = 1;

/** ACP error codes beyond the standard JSON-RPC ones. */
export const AcpErrorCode = {
  AuthRequired: -32000,
  ResourceNotFound: -32002,
  RequestCancelled: -32800,
} as const;

const SessionId = z.string().min(1);
const AbsolutePath = z.string().min(1);
const NameValue = z.object({ name: z.string(), value: z.string() });

const McpServer = z.union([
  z.object({
    type: z.enum(["http", "sse"]),
    name: z.string().min(1),
    url: z.string().min(1),
    headers: z.array(NameValue).default([]),
  }),
  z.object({
    type: z.literal("stdio").optional(),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(NameValue).optional(),
  }),
]);

const TextResource = z.object({ uri: z.string(), text: z.string(), mimeType: z.string().nullish() });
const BlobResource = z.object({ uri: z.string(), blob: z.string(), mimeType: z.string().nullish() });

const ContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string(), uri: z.string().nullish() }),
  z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }),
  z.object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    mimeType: z.string().nullish(),
    title: z.string().nullish(),
  }),
  z.object({ type: z.literal("resource"), resource: z.union([TextResource, BlobResource]) }),
]);

const SessionSetup = { cwd: AbsolutePath, mcpServers: z.array(McpServer).default([]) };

export const AcpParams = {
  initialize: z.object({
    protocolVersion: z.number().int().nonnegative(),
    clientCapabilities: z
      .object({
        auth: z.object({ terminal: z.boolean().optional() }).nullish(),
        elicitation: z.object({ form: z.object({}).nullish() }).nullish(),
        _meta: z.record(z.string(), z.unknown()).nullish(),
      })
      .nullish(),
    clientInfo: z.object({ name: z.string(), version: z.string().optional() }).nullish(),
  }),
  authenticate: z.object({ methodId: z.string() }),
  "session/new": z.object(SessionSetup),
  "session/load": z.object({ sessionId: SessionId, ...SessionSetup }),
  "session/resume": z.object({ sessionId: SessionId, ...SessionSetup }),
  "session/close": z.object({ sessionId: SessionId }),
  "session/list": z.object({ cwd: AbsolutePath.nullish(), cursor: z.string().nullish() }),
  "session/delete": z.object({ sessionId: SessionId }),
  "session/prompt": z.object({ sessionId: SessionId, prompt: z.array(ContentBlock) }),
  "session/set_mode": z.object({ sessionId: SessionId, modeId: z.string() }),
  "session/cancel": z.object({ sessionId: SessionId }),
} as const;

export type AcpMethod = keyof typeof AcpParams;
export type AcpParamsOf<M extends AcpMethod> = z.infer<(typeof AcpParams)[M]>;

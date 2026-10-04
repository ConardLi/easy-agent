/**
 * Easy Agent session SDK.
 *
 *   const runtime = await createAgentRuntime({ cwd: process.cwd() });
 *   const session = await runtime.createSession();
 *   session.subscribe((event) => { ... });
 *   await session.send("Explain this repository");
 *
 * See docs/sdk.md for the stability guarantees of each export.
 */

export { AgentRuntime, createAgentRuntime, INTERACTIVE_DEFAULT_MAX_TURNS } from "./runtime.js";
export { AgentSession } from "./session.js";
export { AgentSdkError, isAgentSdkError, type AgentSdkErrorCode } from "./errors.js";
export type { WorkspaceReport } from "./bootstrap.js";
export * from "./types.js";

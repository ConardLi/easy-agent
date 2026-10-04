/** Errors raised by the session SDK. `code` is stable; messages are for humans. */

export type AgentSdkErrorCode =
  /** A turn is already running in this session. */
  | "busy"
  /** The session was closed. */
  | "closed"
  /** `/resume` moved the conversation to another session object. */
  | "replaced"
  /** Loading permission settings failed while opening a session. */
  | "permission_settings"
  /** Restoring a saved session failed. */
  | "session_restore"
  /** Creating the transcript of a new session failed. */
  | "session_storage"
  /** Another runtime is already active in this process. */
  | "runtime_active"
  /** The session is already open in this runtime. */
  | "already_open";

export class AgentSdkError extends Error {
  readonly code: AgentSdkErrorCode;

  constructor(code: AgentSdkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentSdkError";
    this.code = code;
  }
}

export function isAgentSdkError(error: unknown, code?: AgentSdkErrorCode): error is AgentSdkError {
  return error instanceof AgentSdkError && (code === undefined || error.code === code);
}

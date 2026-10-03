/**
 * Delimiters around the static and dynamic sections of the rendered system
 * prompt. The context layer emits them; the API layer splits on the static
 * end marker to place the prompt-cache breakpoint.
 */
export const SYSTEM_PROMPT_STATIC_START = "<SYSTEM_STATIC_CONTEXT>";
export const SYSTEM_PROMPT_STATIC_END = "</SYSTEM_STATIC_CONTEXT>";
export const SYSTEM_PROMPT_DYNAMIC_START = "<SYSTEM_DYNAMIC_CONTEXT>";
export const SYSTEM_PROMPT_DYNAMIC_END = "</SYSTEM_DYNAMIC_CONTEXT>";

/**
 * Prefix of the hidden user message that reports context changes made after
 * the session's system prompt was written. The transcript view skips it.
 */
export const CONTEXT_UPDATE_MARKER = "[context_update]";

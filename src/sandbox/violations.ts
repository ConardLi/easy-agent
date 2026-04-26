/**
 * Sandbox-violation feedback link.
 *
 * macOS sandbox-exec writes denial events to syslog (visible via
 * `log show --predicate 'sender == "Sandbox"'`), NOT to the spawned
 * process's stderr. So we cannot extract violations from stderr the
 * way source code's `@anthropic-ai/sandbox-runtime` does (it taps the
 * `log stream` API directly).
 *
 * Easy-agent's tutorial-grade implementation does the simplest thing
 * that still gives the model a recoverable signal:
 *
 *   1. After the sandboxed process exits, we scan stderr for the
 *      classic deny indicators (EPERM, EACCES, "Operation not
 *      permitted", "sandbox-exec:"), and if we see any of them, we
 *      ATTRIBUTE the failure to the sandbox.
 *
 *   2. We append a `<sandbox_violations>...</sandbox_violations>`
 *      block to stderr. The model sees it and knows "this wasn't a
 *      command bug, this was the sandbox enforcing policy" — it can
 *      decide to ask for permission, change approach, or give up.
 *
 *   3. The UI strips the tag before showing stderr to the human, so
 *      they see clean output.
 *
 * If the user wants the rich production behavior (full violation
 * list with paths/domains), they'd need to subscribe to `log stream`
 * — explicitly out of scope for stage 18 (see DEVELOPMENT-PLAN 18.6).
 */

const SANDBOX_VIOLATION_INDICATORS = [
  "Operation not permitted",
  "operation not permitted",
  "sandbox-exec:",
  "deny file-write",
  "deny network-outbound",
  "EPERM",
  "EACCES",
];

const VIOLATION_TAG_RE = /<sandbox_violations>[\s\S]*?<\/sandbox_violations>/g;

export function looksLikeSandboxViolation(stderr: string): boolean {
  if (!stderr) return false;
  return SANDBOX_VIOLATION_INDICATORS.some((indicator) => stderr.includes(indicator));
}

/**
 * Wraps stderr in a sandbox_violations tag IF we believe a sandbox
 * denial caused the failure. Returns the stderr unchanged otherwise.
 */
export function annotateStderrWithSandboxFailures(
  stderr: string,
  exitCode: number | null,
): string {
  if (!stderr) return stderr;
  if (exitCode === 0 || exitCode === null) return stderr;
  if (!looksLikeSandboxViolation(stderr)) return stderr;
  if (VIOLATION_TAG_RE.test(stderr)) {
    VIOLATION_TAG_RE.lastIndex = 0;
    return stderr;
  }
  return `${stderr}\n<sandbox_violations>\nThe command appears to have been blocked by the sandbox. The error indicators above (e.g. "Operation not permitted") are typical of file-write or network policy violations.\n</sandbox_violations>`;
}

/** UI-side: strip the tag before showing stderr to the human. */
export function removeSandboxViolationTags(text: string): string {
  return text.replace(VIOLATION_TAG_RE, "").trim();
}

/** Returns true if the stderr carries a sandbox-violations tag. */
export function hasSandboxViolationTag(text: string): boolean {
  if (!text) return false;
  const re = /<sandbox_violations>/;
  return re.test(text);
}

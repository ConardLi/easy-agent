/** Explicit compatibility switch for endpoints that reject beta fields. */
export function areExperimentalBetasDisabled(): boolean {
  return [process.env.EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS, process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS].some(
    (value) => /^(1|true|yes|on)$/i.test(value?.trim() ?? ""),
  );
}

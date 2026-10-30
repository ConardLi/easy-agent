import { harnessSetting } from "../harness/active.js";

/**
 * Explicit compatibility switch for endpoints that reject beta fields: the
 * Agent's `features.experimentalBetas`, which
 * EASY_AGENT_DISABLE_EXPERIMENTAL_BETAS (or the CLAUDE_CODE_ name) turns off.
 */
export function areExperimentalBetasDisabled(): boolean {
  return !harnessSetting<boolean>("features.experimentalBetas");
}

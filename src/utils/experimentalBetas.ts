import { harnessSetting } from "../harness/active.js";

/**
 * Explicit compatibility switch for endpoints that reject beta fields: the
 * Agent's `features.experimentalBetas`, resolved from canonical configuration.
 */
export function areExperimentalBetasDisabled(): boolean {
  return !harnessSetting<boolean>("features.experimentalBetas");
}

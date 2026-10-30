/** Key-by-key comparison of two resolved harnesses. */

import { HARNESS_KEYS } from "./keys.js";
import type { ResolvedHarness, ResolvedHarnessValue } from "./resolve.js";

export interface HarnessDiffSide {
  value: unknown;
  source: ResolvedHarnessValue["source"];
  detail?: string;
}

export interface HarnessDifference {
  path: string;
  a: HarnessDiffSide;
  b: HarnessDiffSide;
}

export interface HarnessDiff {
  a: { name: string; hash: string };
  b: { name: string; hash: string };
  differences: HarnessDifference[];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

const same = (x: unknown, y: unknown) => JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));

const side = (entry: ResolvedHarnessValue): HarnessDiffSide => ({
  value: entry.value,
  source: entry.source,
  ...(entry.detail ? { detail: entry.detail } : {}),
});

/** Keys whose values differ, in key order. Sources alone do not count as a difference. */
export function diffHarnesses(a: ResolvedHarness, b: ResolvedHarness): HarnessDiff {
  const differences: HarnessDifference[] = [];
  for (const { path } of HARNESS_KEYS) {
    const left = a.values[path];
    const right = b.values[path];
    if (!left || !right || same(left.value, right.value)) continue;
    differences.push({ path, a: side(left), b: side(right) });
  }
  return { a: { name: a.name, hash: a.hash }, b: { name: b.name, hash: b.hash }, differences };
}

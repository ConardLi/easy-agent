/**
 * The Agent a saved session runs with.
 *
 * A session records the Agent's name, the hash of its resolved settings, and
 * a digest of each setting. Reopening it compares that record with the Agent
 * the runtime runs: the same one unchanged, the same one with settings that
 * changed since, one that was deleted, or another Agent. Sessions saved
 * before Agents were recorded count as `default`.
 */

import { createHash } from "node:crypto";
import { recordSessionHarness, type RestoredSession, type SessionHarnessRecord } from "../session/storage.js";
import { harnessDefined, type ResolvedHarness } from "./resolve.js";

export interface SessionHarnessCheck {
  /** The Agent the session last ran with; `default` without a hash for sessions saved before Agents were recorded. */
  recorded: { name: string; hash?: string };
  /** The Agent it runs with now: the runtime's. */
  current: { name: string; hash: string };
  /**
   * - `same`: the same Agent, and no setting it recorded has changed.
   * - `changed`: the same Agent; the settings in `changed` differ from when it last ran.
   * - `deleted`: the Agent it last ran with no longer exists.
   * - `other`: the runtime runs another Agent.
   */
  status: "same" | "changed" | "deleted" | "other";
  /** With `changed`: the settings whose values differ, in key order. */
  changed: string[];
  /** What to tell the user; absent with `same`. */
  message?: string;
}

const INLINE = "(inline)";
const MAX_LISTED = 8;

function canonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sorted(value)) ?? "null";
}

const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex").slice(0, 12);

/** What a session records about the Agent it runs with. */
export function sessionHarnessRecord(resolved: ResolvedHarness): SessionHarnessRecord {
  return {
    name: resolved.name,
    hash: resolved.hash,
    keys: Object.fromEntries(Object.entries(resolved.values).map(([key, entry]) => [key, digest(entry.value)])),
  };
}

/**
 * A saved session opens with `harness`: compare it with the Agent the
 * session last ran with and, with `record`, record it when the two differ
 * (another Agent, changed settings, or no record yet).
 */
export async function bindSessionHarness(
  cwd: string,
  restored: Pick<RestoredSession, "summary" | "harness">,
  harness: ResolvedHarness,
  record: boolean,
): Promise<SessionHarnessCheck> {
  const recorded = restored.harness;
  const name = recorded?.name ?? "default";
  const exists = name === harness.name || (name !== INLINE && (await harnessDefined(cwd, name)));
  const check = checkSessionHarness(recorded, harness, exists);
  const current = recorded !== null && recorded.name === harness.name && recorded.hash === harness.hash;
  if (record && !current) await recordSessionHarness(restored.summary, sessionHarnessRecord(harness));
  return check;
}

const label = (name: string): string => (name === INLINE ? "a spec passed directly" : `Agent "${name}"`);

/**
 * Compare a session's record with the Agent it opens with. Settings a newer
 * version added, or that the record does not have, do not count as changed.
 * `recordedExists` tells whether the recorded Agent is still defined.
 */
export function checkSessionHarness(
  recorded: SessionHarnessRecord | null,
  current: ResolvedHarness,
  recordedExists: boolean,
): SessionHarnessCheck {
  const name = recorded?.name ?? "default";
  const base = {
    recorded: recorded ? { name, hash: recorded.hash } : { name },
    current: { name: current.name, hash: current.hash },
  };
  if (name !== current.name) {
    const status = recordedExists ? "other" : "deleted";
    const message =
      status === "deleted"
        ? `This session last ran with ${label(name)}, which no longer exists; it continues with ${label(current.name)}.`
        : `This session last ran with ${label(name)}; it continues with ${label(current.name)}, the Agent this runtime runs.`;
    return { ...base, status, changed: [], message };
  }
  const changed = recorded
    ? Object.entries(current.values)
        .filter(([key, entry]) => recorded.keys[key] !== undefined && recorded.keys[key] !== digest(entry.value))
        .map(([key]) => key)
    : [];
  if (changed.length === 0) return { ...base, status: "same", changed };
  const listed = changed.slice(0, MAX_LISTED).join(", ");
  const more = changed.length > MAX_LISTED ? ` and ${changed.length - MAX_LISTED} more` : "";
  return {
    ...base,
    status: "changed",
    changed,
    message: `${label(name)} has changed since this session last ran: ${listed}${more}.`,
  };
}

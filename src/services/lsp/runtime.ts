import { extname } from "node:path";
import { LspClient } from "./client.js";
import type { LspServerConfig } from "./schema.js";

export interface LspRegistration {
  name: string;
  config: LspServerConfig;
  cwd: string;
}
let active = new Map<string, { registration: LspRegistration; client: LspClient }>();
let queue = Promise.resolve();
let cleanupInstalled = false;

/** Serialize server reconciliation; failed replacements leave the valid client active. */
export async function applyLspServers(registrations: LspRegistration[]): Promise<string[]> {
  const errors: string[] = [];
  const run = queue
    .catch(() => {})
    .then(async () => {
      const desired = new Map(registrations.map((entry) => [entry.name, entry]));
      for (const [name, previous] of active) {
        if (!desired.has(name)) {
          active.delete(name);
          await previous.client.stop();
        }
      }
      for (const [name, registration] of desired) {
        const previous = active.get(name);
        if (
          previous &&
          JSON.stringify(previous.registration) === JSON.stringify(registration) &&
          previous.client.status === "ready"
        )
          continue;
        const client = new LspClient(registration.config, registration.cwd);
        try {
          await client.start();
          active.set(name, { registration, client });
          await previous?.client.stop();
        } catch {
          await client.stop();
          errors.push(
            `${name}: could not initialize LSP server; check command, protocol and timeout${previous ? "; retained previous server" : ""}`,
          );
        }
      }
      if (!cleanupInstalled) {
        cleanupInstalled = true;
        process.once("exit", () => {
          for (const entry of active.values()) entry.client.forceStop();
        });
      }
    });
  queue = run;
  await run;
  return errors;
}

export function getLspStatus(): { name: string; status: string; error?: string }[] {
  return [...active].map(([name, entry]) => ({ name, status: entry.client.status, error: entry.client.error }));
}
export function findLspServer(file: string) {
  const extension = extname(file);
  return [...active.values()].find((entry) => Object.hasOwn(entry.registration.config.extensionToLanguage, extension));
}
export async function stopAllLspServers(): Promise<void> {
  await queue.catch(() => {});
  const previous = active;
  active = new Map();
  await Promise.all([...previous.values()].map((entry) => entry.client.stop()));
}

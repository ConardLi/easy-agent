import { extname } from "node:path";
import { LspClient } from "./client.js";
import type { LspServerConfig } from "./schema.js";
import { pluginOffByAgent } from "../../harness/resources.js";
import { bindRuntimeScope, defineRuntimeState, runtimeScopeClosed } from "../../state/runtimeScope.js";

export interface LspRegistration {
  name: string;
  config: LspServerConfig;
  cwd: string;
  pluginId?: string;
}
const state = defineRuntimeState(
  "lsp",
  () => ({
    active: new Map<string, { registration: LspRegistration; client: LspClient }>(),
    starting: new Set<LspClient>(),
    queue: Promise.resolve(),
    generation: 0,
  }),
  async (owner) => {
    owner.generation++;
    await Promise.allSettled([
      ...[...owner.active.values()].map((entry) => entry.client.stop()),
      ...[...owner.starting].map((client) => client.stop()),
    ]);
    await owner.queue.catch(() => {});
    for (const entry of owner.active.values()) processClients.delete(entry.client);
    for (const client of owner.starting) processClients.delete(client);
    owner.active.clear();
    owner.starting.clear();
  },
);
let cleanupInstalled = false;
const processClients = new Set<LspClient>();

/** Serialize server reconciliation; failed replacements leave the valid client active. */
export async function applyLspServers(registrations: LspRegistration[]): Promise<string[]> {
  if (runtimeScopeClosed()) return [];
  const owner = state();
  const { active } = owner;
  const generation = owner.generation;
  const errors: string[] = [];
  const run = owner.queue
    .catch(() => {})
    .then(
      bindRuntimeScope(async () => {
        if (runtimeScopeClosed() || owner.generation !== generation) return;
        const desired = new Map(registrations.map((entry) => [entry.name, entry]));
        for (const [name, previous] of active) {
          if (!desired.has(name)) {
            active.delete(name);
            await previous.client.stop();
            processClients.delete(previous.client);
          }
        }
        for (const [name, registration] of desired) {
          if (runtimeScopeClosed() || owner.generation !== generation) return;
          const previous = active.get(name);
          if (
            previous &&
            JSON.stringify(previous.registration) === JSON.stringify(registration) &&
            previous.client.status === "ready"
          )
            continue;
          const client = new LspClient(registration.config, registration.cwd);
          owner.starting.add(client);
          processClients.add(client);
          installCleanup();
          try {
            await client.start();
            if (runtimeScopeClosed() || owner.generation !== generation) {
              await client.stop();
              processClients.delete(client);
              return;
            }
            active.set(name, { registration, client });
            await previous?.client.stop();
            if (previous) processClients.delete(previous.client);
          } catch {
            await client.stop();
            processClients.delete(client);
            errors.push(
              `${name}: could not initialize LSP server; check command, protocol and timeout${previous ? "; retained previous server" : ""}`,
            );
          } finally {
            owner.starting.delete(client);
          }
        }
      }),
    );
  owner.queue = run;
  await run;
  return errors;
}

function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once("exit", () => {
    for (const client of processClients) client.forceStop();
  });
}

export function getLspStatus(): { name: string; status: string; error?: string }[] {
  return [...state().active].map(([name, entry]) => ({ name, status: entry.client.status, error: entry.client.error }));
}
export function findLspServer(file: string) {
  const extension = extname(file);
  return [...state().active.values()].find(
    (entry) =>
      !pluginOffByAgent(entry.registration.pluginId) &&
      Object.hasOwn(entry.registration.config.extensionToLanguage, extension),
  );
}
export async function stopAllLspServers(): Promise<void> {
  const owner = state();
  owner.generation++;
  await Promise.all([...owner.starting].map((client) => client.stop()));
  await owner.queue.catch(() => {});
  const previous = owner.active;
  owner.active = new Map();
  await Promise.all(
    [...previous.values()].map(async (entry) => {
      await entry.client.stop();
      processClients.delete(entry.client);
    }),
  );
}

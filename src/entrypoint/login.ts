/**
 * `eagent --login`: save a model provider API key in the user settings.
 *
 * Editors that speak ACP run this in a terminal when the agent reports that
 * it has no credentials; it also works on its own. The key goes into the
 * `env` block of `~/.easy-agent/settings.json`, which only the user can read,
 * and applies to every workspace. Entering nothing keeps the current value.
 */

import * as readline from "node:readline";
import { getUserSettingsPath } from "../utils/paths.js";
import { readJsonSettingsFile, updateUserSettings } from "../utils/settings.js";
import { validateSettings } from "../config/schema.js";
import { MODEL_PROTOCOLS, ModelProfileSchema, type ModelProfileConfig } from "../config/modelSchema.js";
import { configEnum, ConfigurationError } from "../config/values.js";

export async function runLogin(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("eagent --login needs an interactive terminal.\n");
    return 1;
  }
  const settingsPath = getUserSettingsPath();
  const { raw, parseError } = await readJsonSettingsFile<Record<string, unknown>>(settingsPath);
  if (parseError) {
    process.stderr.write(`Cannot update ${settingsPath}: ${parseError}\n`);
    return 1;
  }
  const saved = raw ?? {};
  const { errors } = validateSettings(saved, settingsPath);
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    return 1;
  }
  const savedEnv = { ...((saved.env ?? {}) as Record<string, string>) };
  const models = { ...((saved.models ?? {}) as Record<string, ModelProfileConfig>) };

  process.stdout.write(
    "Easy Agent setup\n\n" +
      "Create a model profile with an explicit protocol and one API Key.\n" +
      `It is saved to ${settingsPath}, readable only by you. Press Enter to keep a current value.\n\n`,
  );
  try {
    const id = (await ask("Profile ID [main]: ")).trim() || "main";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))
      throw new ConfigurationError("profile ID", "use 1–64 letters, digits, dots, underscores, or hyphens.");
    const existing = models[id];
    const protocol = configEnum(
      (await ask(`Protocol (${MODEL_PROTOCOLS.join(" | ")})${existing ? ` [${existing.protocol}]` : ""}: `)).trim() ||
        existing?.protocol,
      "protocol",
      MODEL_PROTOCOLS,
    );
    if (!protocol) throw new ConfigurationError("protocol", "select a protocol explicitly.");
    const model = (await ask(`Upstream model${existing ? ` [${existing.model}]` : ""}: `)).trim() || existing?.model;
    if (!model) throw new ConfigurationError("model", "provide the upstream model name.");
    const baseURL =
      (
        await ask(
          existing?.baseURL && existing.protocol === protocol
            ? "Base URL (Enter to keep the existing endpoint; 'official' to reset): "
            : "Base URL (Enter for this protocol's official endpoint): ",
        )
      ).trim() ||
      (existing?.protocol === protocol ? existing.baseURL : "") ||
      "";
    const endpoint = baseURL === "official" ? undefined : baseURL || undefined;
    const authentication = (await ask("Authentication [key] (key | none): ")).trim() || "key";
    if (!["key", "none"].includes(authentication))
      throw new ConfigurationError("authentication", "choose key or none.");
    let apiKey: ModelProfileConfig["apiKey"];
    if (authentication === "key") {
      const key = (
        await askHidden(`API Key${existing?.apiKey ? " (Enter to retain this profile's existing source)" : ""}: `)
      ).trim();
      if (key) {
        // A distinct reference prevents adding one provider from replacing
        // the credentials of any previously saved profile.
        const variable = `PROFILE_${id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_API_KEY`;
        savedEnv[variable] = key;
        apiKey = `\${${variable}}`;
      } else if (existing?.apiKey && existing.protocol === protocol && existing.baseURL === endpoint) {
        apiKey = existing.apiKey;
      } else throw new ConfigurationError("apiKey", "provide an API Key for this connection.");
    }
    const profile = ModelProfileSchema.parse({
      ...(existing?.protocol === protocol && existing.baseURL === endpoint ? existing : {}),
      protocol,
      model,
      baseURL: endpoint,
      apiKey,
      authentication:
        authentication === "none"
          ? { type: "none" }
          : existing?.protocol === protocol &&
              existing.baseURL === endpoint &&
              existing.authentication?.type === "header"
            ? existing.authentication
            : { type: "default" },
    });
    await updateUserSettings({ model: id, models: { ...models, [id]: profile }, env: savedEnv });
    process.stdout.write(`\nSaved profile "${id}" as the default. Reopen the runtime to load its environment.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigurationError ? error.message : "Invalid model configuration; check the profile fields."}\n`,
    );
    return 1;
  }
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/** Read a line without echoing it. */
function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

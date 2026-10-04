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
  const env = { ...((raw?.env ?? {}) as Record<string, string>) };

  process.stdout.write(
    "Easy Agent setup\n\n" +
      "Enter an Anthropic API key, or the key of an Anthropic-compatible endpoint.\n" +
      `It is saved to ${settingsPath}, readable only by you. Press Enter to keep a current value.\n\n`,
  );
  const hasKey = Boolean(env.ANTHROPIC_AUTH_TOKEN);
  const key = (await askHidden(`API key${hasKey ? " (configured)" : ""}: `)).trim();
  if (!key && !hasKey) {
    process.stderr.write("No API key entered; nothing was saved.\n");
    return 1;
  }
  const baseUrl = (await ask(`Base URL [${env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}]: `)).trim();
  const model = (await ask(`Model [${env.ANTHROPIC_MODEL ?? "default"}]: `)).trim();

  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (model) env.ANTHROPIC_MODEL = model;
  await updateUserSettings({ env });
  process.stdout.write(
    `\nSaved. OpenAI, Gemini, and other providers are set up as model profiles in ${settingsPath}; see https://github.com/ConardLi/easy-agent/blob/main/docs/configuration.md\n`,
  );
  return 0;
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

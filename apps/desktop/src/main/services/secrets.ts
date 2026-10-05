import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { secretEnvName } from "../../shared/contract";

export interface SecretStore {
  /** Stored names with a masked preview of each value. */
  list(): Record<string, string>;
  /** Store a value, or delete it with null. */
  set(name: string, value: string | null): Promise<void>;
  /** Every stored value, keyed by its environment variable name. */
  env(): Record<string, string>;
}

const mask = (value: string) => (value.length <= 8 ? "••••" : `${value.slice(0, 3)}••••••••${value.slice(-4)}`);

/**
 * API keys encrypted with the OS keychain (`safeStorage`) and kept in one
 * file. The Agent processes get them as environment variables, so a settings
 * file only ever holds a `${EASY_AGENT_KEY_…}` reference.
 */
export function createSecretStore(file: string): SecretStore {
  let encrypted: Record<string, string> = {};
  try {
    encrypted = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    encrypted = {};
  }
  const decrypt = (value: string) => {
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return null;
    }
  };
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    const content = `${JSON.stringify(encrypted, null, 2)}\n`;
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, file);
    });
    return writing;
  };

  return {
    list() {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(encrypted)) {
        const plain = decrypt(value);
        if (plain !== null) out[name] = mask(plain);
      }
      return out;
    },
    async set(name, value) {
      if (value === null) delete encrypted[name];
      else {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统钥匙串不可用，请改用 ${环境变量名} 引用密钥");
        encrypted[name] = safeStorage.encryptString(value).toString("base64");
      }
      await persist();
    },
    env() {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(encrypted)) {
        const plain = decrypt(value);
        if (plain !== null) out[secretEnvName(name)] = plain;
      }
      return out;
    },
  };
}

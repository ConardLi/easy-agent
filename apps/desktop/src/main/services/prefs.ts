import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ACCENTS, type AccentId, DEFAULT_PREFS, FONT_SIZES, type FontSize, type Prefs, THEMES, type Theme } from "../../shared/contract";

export interface PrefsStore {
  get(): Prefs;
  update(patch: Partial<Prefs>): Promise<Prefs>;
  onChange(listener: (prefs: Prefs) => void): void;
}

/** Keep the known keys with valid values; anything else falls back to `base`. */
export function sanitizePrefs(raw: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    theme: THEMES.includes(v.theme as Theme) ? (v.theme as Theme) : base.theme,
    accent: ACCENTS.some((a) => a.id === v.accent) ? (v.accent as AccentId) : base.accent,
    fontSize: FONT_SIZES.includes(v.fontSize as FontSize) ? (v.fontSize as FontSize) : base.fontSize,
    sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : base.sidebarOpen,
  };
}

function readPrefs(file: string): Prefs {
  try {
    return sanitizePrefs(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Preferences in one JSON file, written atomically and one write at a time. */
export function createPrefsStore(file: string): PrefsStore {
  let current = readPrefs(file);
  let writing: Promise<void> = Promise.resolve();
  const listeners: ((prefs: Prefs) => void)[] = [];

  const persist = (prefs: Prefs) => {
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
        await rename(tmp, file);
      })
      .catch((error: unknown) => console.error("Failed to save preferences:", error));
    return writing;
  };

  return {
    get: () => current,
    async update(patch) {
      const next = sanitizePrefs({ ...current, ...patch }, current);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      current = next;
      for (const listener of listeners) listener(current);
      await persist(current);
      return current;
    },
    onChange: (listener) => void listeners.push(listener),
  };
}

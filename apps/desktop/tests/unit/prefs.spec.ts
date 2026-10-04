import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createPrefsStore, sanitizePrefs } from "../../src/main/services/prefs";
import { DEFAULT_PREFS } from "../../src/shared/contract";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "easy-agent-prefs-")), "preferences.json");

test("invalid values fall back and unknown keys are dropped", () => {
  expect(sanitizePrefs({ theme: "neon", accent: 3, fontSize: 18, sidebarOpen: "yes", extra: true })).toEqual(DEFAULT_PREFS);
  expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
  expect(sanitizePrefs({ theme: "light", accent: "jade" })).toEqual({ ...DEFAULT_PREFS, theme: "light", accent: "jade" });
});

test("a missing or corrupt file gives the defaults", () => {
  expect(createPrefsStore(tempFile()).get()).toEqual(DEFAULT_PREFS);
  const file = tempFile();
  writeFileSync(file, "{not json");
  expect(createPrefsStore(file).get()).toEqual(DEFAULT_PREFS);
});

test("updates are validated, persisted, and announced", async () => {
  const file = tempFile();
  const store = createPrefsStore(file);
  const seen: unknown[] = [];
  store.onChange((prefs) => seen.push(prefs));

  await store.update({ theme: "light", accent: "bogus" as never });
  expect(store.get()).toEqual({ ...DEFAULT_PREFS, theme: "light" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(store.get());
  expect(seen).toEqual([store.get()]);

  await store.update({ theme: "light" });
  expect(seen).toHaveLength(1);
  expect(createPrefsStore(file).get()).toEqual(store.get());
});

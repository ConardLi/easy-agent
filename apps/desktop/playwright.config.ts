import { defineConfig } from "@playwright/test";

export default defineConfig({
  // Every Electron test starts its own app; running them one at a time keeps screenshots stable.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  snapshotPathTemplate: "tests/visual/baseline/{arg}{ext}",
  // Baselines come from the style reference only, never from the client itself.
  updateSnapshots: "none",
  expect: {
    toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 0, animations: "disabled" },
  },
  projects: [
    { name: "unit", testDir: "tests/unit" },
    { name: "e2e", testDir: "tests/e2e" },
    { name: "visual", testDir: "tests/visual", testMatch: /\.spec\.ts$/ },
    // Captures the baseline from the style reference; see tests/visual/README.md.
    { name: "baseline", testDir: "tests/visual", testMatch: /\.capture\.ts$/ },
  ],
});

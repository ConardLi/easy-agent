import { expect, test } from "@playwright/test";
import { launchApp } from "../helpers/app";
import { MASK_SELECTOR, SCENARIOS } from "./scenarios";

test.skip(process.platform !== "darwin", "The baselines are captured on macOS.");

for (const scenario of SCENARIOS) {
  test(`matches the style reference: ${scenario.name}`, async () => {
    const { app, page } = await launchApp({ prefs: scenario.prefs });
    try {
      await expect(page).toHaveScreenshot(`${scenario.name}.png`, { mask: [page.locator(MASK_SELECTOR)] });
    } finally {
      await app.close();
    }
  });
}

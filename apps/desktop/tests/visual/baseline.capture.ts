import { join } from "node:path";
import { _electron as electron, test } from "@playwright/test";
import { ELECTRON_FLAGS, electronEnv, fitWindow } from "../helpers/app";
import { MASK_SELECTOR, SCENARIOS } from "./scenarios";

const webUi = process.env.WEB_UI_URL;

test.skip(!webUi, "Set WEB_UI_URL to the running style reference, e.g. http://localhost:5180");

// The reference renders in the same Electron build as the client, so only the styling can differ.
for (const scenario of SCENARIOS) {
  test(`capture ${scenario.name}`, async () => {
    const url = `${webUi}/?${scenario.query}`;
    const app = await electron.launch({
      args: [...ELECTRON_FLAGS, join(import.meta.dirname, "reference-window.cjs")],
      env: electronEnv({ REFERENCE_URL: url }),
    });
    try {
      const page = await app.firstWindow();
      await page.locator("aside").first().waitFor();
      await fitWindow(app, page);
      // Let the entrance animations finish.
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: join(import.meta.dirname, "baseline", `${scenario.name}.png`),
        mask: [page.locator(MASK_SELECTOR)],
        animations: "disabled",
      });
    } finally {
      await app.close();
    }
  });
}

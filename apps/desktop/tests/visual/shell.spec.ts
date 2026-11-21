import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createAgentWorld, openProject, send } from "../helpers/agent";
import { launchApp } from "../helpers/app";
import { replayRequests } from "../helpers/requestReplay";
import { COMPARISON_FIXTURE, CONTEXT_FIXTURE } from "./requestFixtures";
import { prepareRequestView } from "./requestSteps";
import { MASK_SELECTOR, SCENARIOS } from "./scenarios";

test.skip(process.platform !== "darwin", "The baselines are captured on macOS.");

for (const scenario of SCENARIOS) {
  test(`matches the style reference: ${scenario.name}`, async () => {
    if (scenario.requestView) {
      const world = await createAgentWorld();
      const file = join(world.home, ".easy-agent", "settings.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), harnesses: { lean: {} } }));
      const { app, page } = await openProject(world, scenario.prefs);
      try {
        await replayRequests(app, { context: CONTEXT_FIXTURE, comparison: COMPARISON_FIXTURE });
        if (scenario.requestView === "context") {
          world.fixture.script([{ kind: "text", text: "收到。" }]);
          await send(page, "检查这个项目");
          await expect(page.getByText("收到。")).toBeVisible({ timeout: 20_000 });
          await page.getByRole("button", { name: "详情面板", exact: true }).click();
          await page.getByRole("tab", { name: "上下文" }).click();
        } else {
          await page
            .locator("aside")
            .getByRole("button", { name: /^Agent/ })
            .click();
          await page.getByRole("button", { name: "请求对比", exact: true }).click();
        }
        const target = await prepareRequestView(page, scenario.requestView);
        await expect(target).toHaveScreenshot(`${scenario.name}.png`);
      } finally {
        await app.close();
        await world.fixture.close();
      }
      return;
    }
    const { app, page } = await launchApp({ prefs: scenario.prefs });
    try {
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`${scenario.name}.png`, { mask: [page.locator(MASK_SELECTOR)] });
    } finally {
      await app.close();
    }
  });
}

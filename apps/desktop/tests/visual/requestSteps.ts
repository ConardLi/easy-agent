import type { Page } from "@playwright/test";
import type { Scenario } from "./scenarios";

/** The same visible interactions in the style reference and the client. */
export async function prepareRequestView(page: Page, view: Scenario["requestView"]) {
  if (view === "context") {
    const panel = page.locator("[data-context-detail]");
    await panel.getByRole("button", { name: /^技能/ }).click();
    await panel
      .locator('[data-component="skill:user:review"]')
      .getByRole("button", { name: /review/ })
      .click();
    await page.locator("[data-context-viewport]").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.mouse.move(0, 0);
    // macOS overlay scrollbars fade after the programmatic scroll.
    await page.waitForTimeout(1200);
    return page.locator("[data-context-viewport]");
  }
  const comparison = page.locator("[data-request-comparison]");
  await comparison.getByLabel("Agent B", { exact: true }).selectOption("lean");
  await comparison.getByLabel("共同输入").fill("检查这个项目");
  await comparison.getByRole("button", { name: "生成对比", exact: true }).click();
  await comparison.locator('[data-diff-component="prompt_section:identity"]').getByRole("button").click();
  // Clear focus before capturing so platform focus rings match.
  await comparison.getByText("全部 token 均为估算").click();
  await page.mouse.move(0, 0);
  return comparison;
}

import { expect, test } from "@playwright/test";

test("Watchlist leads through the complete Xiaomi analysis prototype", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Watchlist" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Price Graph" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Intrinsic Value" })).toBeVisible();
  await page.getByRole("button", { name: "小 小米集团-W 01810" }).click();
  await expect(page.getByText("213,600 股")).toBeVisible();
  await expect(page.getByText("HK$395,000")).toBeVisible();
  await expect(page.getByText("已完成")).toBeVisible();
  await page.getByRole("button", { name: "Financials" }).click();
  await expect(page.getByRole("heading", { name: "最近五年财务趋势" })).toBeVisible();
  await page.getByRole("button", { name: "DCF Valuation" }).click();
  await page.getByRole("button", { name: "View Calculation" }).click();
  await expect(page.getByRole("dialog", { name: /DCF Model/ })).toBeVisible();
  await page.getByRole("dialog").getByRole("button").first().click();
  await page.getByRole("button", { name: "Relative Valuation" }).click();
  await expect(page.getByText(/Current P\/E/)).toBeVisible();
  await page.getByRole("button", { name: "View Calculation" }).click();
  await expect(page.getByRole("dialog", { name: /Relative Valuation/ })).toBeVisible();
});

test("first prototype does not load the deferred product surfaces", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Watchlist" })).toBeVisible();
  await expect(page.getByRole("button", { name: "决策" })).toHaveCount(0);
  await expect(page.getByText("李录评分")).toHaveCount(0);
  await expect(page.getByText("Michael Burry")).toHaveCount(0);
  await expect(page.getByLabel("向研究助手提问")).toHaveCount(0);
});

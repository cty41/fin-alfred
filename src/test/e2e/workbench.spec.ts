import { expect, test } from "@playwright/test";

test("Xiaomi stage one is completed and agent creates only a draft", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Stage 1完成率 106.38%")).toBeVisible();
  await expect(page.getByText("已由真实成交完成，禁止重复建议")).toBeVisible();
  await page.getByLabel("向研究助手提问").fill("为Stage 2生成策略草稿");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("region", { name: "发送内容预览" })).toBeVisible();
  await page.getByRole("button", { name: "确认发送" }).click();
  await expect(page.getByText("小米 Stage 2 反弹减仓检查表")).toBeVisible();
  await expect(page.getByText("策略草稿 · 未发布")).toBeVisible();
});

test("family profile is isolated and switching restores Xiaomi fixture", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 新建档案" }).click();
  await page.getByLabel("新档案名称").fill("家人投资档案");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("先录入并核验该档案的初始持仓").first()).toBeVisible();
  await expect(page.getByText("Stage 1完成率 106.38%")).not.toBeVisible();
  await page.getByLabel("切换投资档案").selectOption("profile-xiaomi-real");
  await expect(page.getByText("Stage 1完成率 106.38%")).toBeVisible();
  await expect(page.getByText("已由真实成交完成，禁止重复建议")).toBeVisible();
});

test("decision approval remains separate from execution and replay is deterministic", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "决策" }).click();
  await page.getByText("我确认已出现明显反弹").click();
  await page.getByText("最新估值与行情仍在有效期").click();
  await page.getByRole("button", { name: "按当前快照确定性评估" }).click();
  await expect(page.getByText("建议卖出 10,560 股")).toBeVisible();
  await page.getByRole("button", { name: "接受建议" }).click();
  await expect(page.getByText("建议已接受；尚未登记任何成交，持仓和现金未改变。")).toBeVisible();
  await page.getByRole("button", { name: "验证重放" }).click();
  await expect(page.getByText("确定性重放一致。")).toBeVisible();
});

test("ledger and audit navigation stay on the selected profile", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "账本" }).click();
  await expect(page.getByRole("cell", { name: "2026-08-14", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "12,000" })).toBeVisible();
  await page.getByRole("button", { name: "＋ 新建档案" }).click();
  await page.getByLabel("新档案名称").fill("隔离审计档案");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText("该档案尚无真实成交。")).toBeVisible();
  await page.getByRole("button", { name: "审计" }).click();
  await expect(page.getByText("该档案尚无审计事件。")).toBeVisible();
});

test("formal strategy requires draft validation and explicit user publication", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "决策" }).click();
  const editor = page.getByLabel("策略 DSL JSON");
  await editor.fill(JSON.stringify({ schema_version: 1, strategy_id: "smuggled", version: "1", condition: { kind: "human_confirmation", checklist_id: "manual" }, suggestion: { action: "review", reason_code: "MANUAL", invalidation: "stale" }, lifecycle: "PUBLISHED" }));
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText(/only draft strategies/)).toBeVisible();

  await editor.fill(JSON.stringify({ schema_version: 1, strategy_id: "failing-scenario", version: "1", condition: { kind: "human_confirmation", checklist_id: "manual" }, suggestion: { action: "review", reason_code: "MANUAL", invalidation: "stale" }, lifecycle: "DRAFT", test_scenarios: [{ name: "contradiction", inputs: { manual: false }, expected_match: true, expected_action: "review" }] }));
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "校验" }).click();
  await expect(page.getByText(/passing test scenarios/)).toBeVisible();
  await expect(page.getByText("DRAFT", { exact: true }).last()).toBeVisible();

  await editor.fill(JSON.stringify({ schema_version: 1, strategy_id: "xiaomi-stage-2", version: "1", condition: { kind: "human_confirmation", checklist_id: "rebound-confirmation" }, suggestion: { action: "review_sell_gap", reason_code: "STAGE_2_REBOUND", invalidation: "fundamental_thesis_invalidated" }, lifecycle: "DRAFT", test_scenarios: [{ name: "confirmed rebound", inputs: { "rebound-confirmation": true }, expected_match: true, expected_action: "review_sell_gap" }] }));
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("DRAFT", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "人工发布" }).last()).toBeDisabled();
  await page.getByRole("button", { name: "校验" }).last().click();
  await expect(page.getByText("VALIDATED", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "人工发布" }).last().click();
  await expect(page.getByText("PUBLISHED", { exact: true })).toBeVisible();
  await expect(page.getByText(/策略已由本机用户明确发布/)).toBeVisible();
});

test("family profile establishes one baseline and records a broker execution without trading", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 新建档案" }).click();
  await page.getByLabel("新档案名称").fill("家人实盘档案");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "账本" }).click();
  await page.getByLabel("初始持股").fill("1000");
  await page.getByLabel("初始现金").fill("50000");
  await page.getByRole("button", { name: "确认并建立基线" }).click();
  await expect(page.getByRole("heading", { name: "登记既成券商成交" })).toBeVisible();
  await page.getByLabel("手工成交日期").fill("2026-08-18");
  await page.getByLabel("手工成交股数").fill("100");
  await page.getByLabel("手工成交均价").fill("25");
  await page.getByLabel("手工手续费").fill("10");
  await page.getByLabel("手工券商成交编号").fill("family-broker-001");
  await page.getByRole("button", { name: "登记既成成交" }).click();
  await expect(page.getByText(/既成成交已原子登记/)).toBeVisible();
  await page.getByRole("button", { name: "组合" }).click();
  await expect(page.getByText("900股")).toBeVisible();
  await expect(page.getByText("HK$52,490")).toBeVisible();
});

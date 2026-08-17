import { expect, test } from "@playwright/test";

test("real Gateway serves the idempotent ledger and restricted MCP", async ({ page, request }) => {
  const unauthenticated = await request.post("http://127.0.0.1:43117/api/v1/invoke/get_overview", {
    headers: { host: "127.0.0.1:43117", origin: "http://127.0.0.1:43117" },
    data: {},
  });
  expect(unauthenticated.status()).toBe(401);
  const hostileOrigin = await request.post("http://127.0.0.1:43117/api/v1/session", {
    headers: { host: "127.0.0.1:43117", origin: "https://attacker.invalid" },
    data: { token: "gateway-e2e-bootstrap" },
  });
  expect(hostileOrigin.status()).toBe(403);
  const fakeMcpToken = await request.post("http://127.0.0.1:43117/mcp", {
    headers: { authorization: "Bearer invalid", host: "127.0.0.1:43117" },
    data: { jsonrpc: "2.0", id: 0, method: "tools/list" },
  });
  expect(fakeMcpToken.status()).toBe(401);
  await page.goto("/#token=gateway-e2e-bootstrap");
  await expect(page.getByText("Stage 1完成率 106.38%")).toBeVisible();
  await page.getByRole("button", { name: "账本" }).click();
  await expect(page.getByRole("cell", { name: "2026-08-14", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "12,000" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Stage 1完成率 106.38%")).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("button", { name: "创建 MCP 令牌" }).click();
  const token = await page.locator("output code").last().textContent();
  expect(token).toBeTruthy();
  const response = await request.post("http://127.0.0.1:43117/mcp", {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1:43117" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(response.ok()).toBeTruthy();
  const body = JSON.stringify(await response.json());
  expect(body).toContain("create_strategy_draft");
  expect(body).not.toContain("publish_strategy");
  expect(body).not.toContain("record_decision_execution");

  const crossProfile = await request.post("http://127.0.0.1:43117/mcp", {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1:43117" },
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_profile_activity", arguments: { profileId: "forged-family-profile" } },
    },
  });
  expect(JSON.stringify(await crossProfile.json())).toContain("cannot access another profile");

  const forbiddenCall = await request.post("http://127.0.0.1:43117/mcp", {
    headers: { authorization: `Bearer ${token}`, host: "127.0.0.1:43117" },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "record_decision_execution", arguments: {} },
    },
  });
  expect(JSON.stringify(await forbiddenCall.json())).toContain("tool is not available to MCP");
});

import { describe, expect, it } from "vitest";
import { xiaomiOverview } from "./mockData";

describe("xiaomi real fixture", () => {
  it("matches the supplied execution and closing balances", () => {
    const transaction = xiaomiOverview.transaction!;
    expect(Number(xiaomiOverview.initialQuantity) - Number(transaction.quantity)).toBe(Number(xiaomiOverview.currentQuantity));
    expect(Number(transaction.grossAmount.amount)).toBe(307_440);
    expect(Number(transaction.fees.total.amount)).toBe(329);
    expect(Number(transaction.netCashFlow.amount)).toBe(307_111);
    expect(Number(xiaomiOverview.cash.amount)).toBe(395_000);
  });

  it("marks stage one complete and never leaves a remaining stage-one quantity", () => {
    const stageOne = xiaomiOverview.stages[0];
    expect(stageOne.status).toBe("completed");
    expect(Number(stageOne.actualCumulativeQuantity)).toBeGreaterThanOrEqual(Number(stageOne.cumulativeTargetQuantity));
  });
});

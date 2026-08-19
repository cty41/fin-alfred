import { describe, it, expect } from "vitest";
import { d } from "@fin-alfred/core";
import { StagedStrategy, type StrategyStage, type MarketContext } from "@fin-alfred/core";

/**
 * Xiaomi staged reduction fixture:
 * - Baseline 225,600 shares
 * - Stage 1: 5% unconditional (already done: 12,000 sold)
 * - Stage 2: cumulative 10%, zone 28.8-29.3, needs 2 consecutive closes >= 28.8
 * - Stage 3: cumulative 15%, zone 31-32, catalyst gate (EV orders)
 * - Stage 4: cumulative 20%, zone > Base*0.9
 */
function xiaomiStages(): StrategyStage[] {
  return [
    {
      stage: 1,
      cumulativeTarget: d("11280"),
      zones: [{ low: d("0"), high: d("99999") }],
      confirmations: [],
      rationale: "Unconditional insurance sale",
    },
    {
      stage: 2,
      cumulativeTarget: d("22560"),
      zones: [{ low: d("28.8"), high: d("29.3") }],
      confirmations: [{ kind: "consecutive_closes_above_zone_low", count: 2 }],
      rationale: "Concentration management at July price recovery zone",
    },
    {
      stage: 3,
      cumulativeTarget: d("33840"),
      zones: [{ low: d("31"), high: d("32") }],
      confirmations: [],
      catalysts: [
        { id: "ev_orders", label: "Pengcheng new model orders", dueDate: "2026-09-08", confirmed: false, blocking: true },
      ],
      rationale: "Post-results valuation zone",
    },
    {
      stage: 4,
      cumulativeTarget: d("45120"),
      zones: [{ low: d("35"), high: d("99999") }],
      confirmations: [],
      rationale: "Comprehensive risk review zone",
    },
  ];
}

function market(price: string, overrides?: Partial<MarketContext>): MarketContext {
  return {
    price: d(price),
    dailyCloses: [d(price)],
    asOf: "2026-08-19",
    ...overrides,
  };
}

describe("StagedStrategy - Xiaomi fixture", () => {
  const strategy = new StagedStrategy("HKEX:1810", d("225600"), xiaomiStages());

  it("stage 1 already completed, stage 2 remaining is 10560", () => {
    expect(strategy.remainingToStage(1, d("12000"))!.toString()).toBe("0");
    expect(strategy.remainingToStage(2, d("12000"))!.toString()).toBe("10560");
  });

  it("price below zone => wait with detail", () => {
    const outcome = strategy.evaluate(market("27.42"), d("12000"));
    expect(outcome.outcome).toBe("wait");
    if (outcome.outcome === "wait") {
      expect(outcome.reasonCode).toBe("PRICE_OUTSIDE_EXECUTION_ZONE");
      expect(outcome.detail).toContain("28.8");
    }
  });

  it("price in zone but confirmation missing => wait", () => {
    const outcome = strategy.evaluate(
      market("29.0", { dailyCloses: [d("29.0")] }),
      d("12000"),
    );
    expect(outcome.outcome).toBe("wait");
    if (outcome.outcome === "wait") {
      expect(outcome.reasonCode).toBe("STAGE_2_CHECKLIST_INCOMPLETE");
      expect(outcome.missingChecks.length).toBeGreaterThan(0);
    }
  });

  it("price in zone + 2 consecutive closes => propose sell", () => {
    const outcome = strategy.evaluate(
      market("29.1", { dailyCloses: [d("28.9"), d("29.1")] }),
      d("12000"),
    );
    expect(outcome.outcome).toBe("propose_sell");
    if (outcome.outcome === "propose_sell") {
      expect(outcome.stage).toBe(2);
      expect(outcome.quantity.toString()).toBe("10560");
    }
  });

  it("stage 3 blocked by unconfirmed catalyst", () => {
    const outcome = strategy.evaluate(
      market("31.5", { dailyCloses: [d("31.5")] }),
      d("22560"),
    );
    expect(outcome.outcome).toBe("wait");
    if (outcome.outcome === "wait") {
      expect(outcome.missingChecks.some((c) => c.includes("Pengcheng"))).toBe(true);
    }
  });

  it("all stages done => completed", () => {
    const outcome = strategy.evaluate(market("40"), d("45120"));
    expect(outcome.outcome).toBe("completed");
  });
});

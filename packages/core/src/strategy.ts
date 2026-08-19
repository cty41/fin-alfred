import { Decimal, d } from "./decimal.js";

/**
 * A price zone in which a stage may be executed, e.g. [28.8, 29.3].
 */
export interface PriceZone {
  low: Decimal;
  high: Decimal;
}

export type ConfirmationKind =
  | "consecutive_closes_above_zone_low" // N consecutive daily closes >= zone.low
  | "weekly_close_above_zone_low" // latest weekly close >= zone.low
  | "rebound_pct_from_recent_low"; // rebound >= pct above trailing-N-day low

export interface ConfirmationRule {
  kind: ConfirmationKind;
  /** Number of consecutive closes for consecutive_closes_above_zone_low */
  count?: number;
  /** Trailing window days for rebound_pct_from_recent_low */
  trailingDays?: number;
  /** Required rebound fraction, e.g. 0.10 for 10% */
  rebound?: Decimal;
}

/**
 * A catalyst gate that can hold a stage open until an event is confirmed
 * or its deadline passes. Encodes things like "Sep 1 new-model orders".
 */
export interface CatalystGate {
  id: string;
  label: string;
  dueDate?: string; // YYYY-MM-DD
  confirmed: boolean;
  /** If true, an unconfirmed catalyst blocks execution even in zone. */
  blocking: boolean;
}

export interface StrategyStage {
  stage: number;
  /** Cumulative shares to be sold by the end of this stage. */
  cumulativeTarget: Decimal;
  /** Zones in which execution is allowed. */
  zones: PriceZone[];
  /** Confirmation rules; all must pass for execution. */
  confirmations: ConfirmationRule[];
  /** Optional catalyst gates. */
  catalysts?: CatalystGate[];
  /** Human description of the stage rationale. */
  rationale?: string;
}

export type StrategyOutcome =
  | { outcome: "wait"; reasonCode: string; missingChecks: string[]; detail?: string }
  | { outcome: "propose_sell"; stage: number; quantity: Decimal; zone: PriceZone; reasonCode: string }
  | { outcome: "exit_review"; reasonCode: string }
  | { outcome: "completed" };

export interface MarketContext {
  /** Latest closing price. */
  price: Decimal;
  /** Recent daily closes, oldest first, newest last (includes latest). */
  dailyCloses: Decimal[];
  /** Latest weekly close, if available. */
  weeklyClose?: Decimal;
  /** Trailing-N-day low close, if provided. */
  trailingLow?: Decimal;
  asOf: string; // YYYY-MM-DD
}

/**
 * Data-driven staged reduction / accumulation engine.
 * Deterministic and idempotent: identical inputs always produce identical outcomes.
 */
export class StagedStrategy {
  constructor(
    public readonly instrumentId: string,
    public readonly baselineQuantity: Decimal,
    public readonly stages: StrategyStage[],
    public readonly side: "reduce" | "accumulate" = "reduce",
  ) {}

  /** Remaining shares to reach a given cumulative stage target. */
  remainingToStage(stage: number, cumulativeSold: Decimal): Decimal | undefined {
    const target = this.stages.find((s) => s.stage === stage)?.cumulativeTarget;
    if (!target) return undefined;
    return target.sub(cumulativeSold).max(Decimal.zero());
  }

  private inZone(price: Decimal, zone: PriceZone): boolean {
    return price.gte(zone.low) && price.lte(zone.high);
  }

  private matchingZone(stage: StrategyStage, price: Decimal): PriceZone | undefined {
    return stage.zones.find((z) => this.inZone(price, z));
  }

  private checkConfirmations(stage: StrategyStage, market: MarketContext): string[] {
    const missing: string[] = [];
    for (const rule of stage.confirmations) {
      switch (rule.kind) {
        case "consecutive_closes_above_zone_low": {
          const need = rule.count ?? 2;
          const low = stage.zones[0]?.low ?? Decimal.zero();
          const closes = market.dailyCloses.slice(-need);
          const ok = closes.length >= need && closes.every((c) => c.gte(low));
          if (!ok) missing.push(`need ${need} consecutive closes >= ${low.toString()}`);
          break;
        }
        case "weekly_close_above_zone_low": {
          const low = stage.zones[0]?.low ?? Decimal.zero();
          const ok = market.weeklyClose !== undefined && market.weeklyClose.gte(low);
          if (!ok) missing.push(`weekly close must be >= ${low.toString()}`);
          break;
        }
        case "rebound_pct_from_recent_low": {
          if (market.trailingLow === undefined || market.trailingLow.isZero()) {
            missing.push("trailing low close required for rebound check");
            break;
          }
          const required = rule.rebound ?? d("0.10");
          const rebound = market.price.div(market.trailingLow).sub(Decimal.one());
          if (rebound.lt(required)) {
            missing.push(
              `rebound ${(rebound.mul(d("100"))).toFixed(2)}% < required ${(required.mul(d("100"))).toFixed(2)}% vs ${market.trailingLow.toString()} low`,
            );
          }
          break;
        }
      }
    }
    return missing;
  }

  private checkCatalysts(stage: StrategyStage, asOf: string): string[] {
    const missing: string[] = [];
    for (const cat of stage.catalysts ?? []) {
      if (cat.confirmed) continue;
      const overdue = cat.dueDate !== undefined && asOf > cat.dueDate;
      if (cat.blocking && !overdue) {
        missing.push(`catalyst "${cat.label}" not yet confirmed (due ${cat.dueDate ?? "n/a"})`);
      }
    }
    return missing;
  }

  /**
   * Evaluate the next actionable stage given current market context and
   * cumulative shares already sold.
   */
  evaluate(market: MarketContext, cumulativeSold: Decimal): StrategyOutcome {
    const next = this.stages.find((s) =>
      (s.cumulativeTarget.sub(cumulativeSold)).isPositive(),
    );
    if (!next) return { outcome: "completed" };

    const zone = this.matchingZone(next, market.price);
    if (!zone) {
      const nearest = next.zones
        .slice()
        .sort((a, b) => Number((a.low.sub(market.price).abs().sub(b.low.sub(market.price).abs())).toNumber()))[0];
      return {
        outcome: "wait",
        reasonCode: "PRICE_OUTSIDE_EXECUTION_ZONE",
        missingChecks: [],
        detail: nearest
          ? `current ${market.price.toString()} below first execution zone ${nearest.low.toString()}–${nearest.high.toString()}`
          : `current ${market.price.toString()} outside all execution zones`,
      };
    }

    const confirmMissing = this.checkConfirmations(next, market);
    const catalystMissing = this.checkCatalysts(next, market.asOf);
    const missing = [...confirmMissing, ...catalystMissing];
    if (missing.length > 0) {
      return {
        outcome: "wait",
        reasonCode: `STAGE_${next.stage}_CHECKLIST_INCOMPLETE`,
        missingChecks: missing,
      };
    }

    const quantity = this.remainingToStage(next.stage, cumulativeSold) ?? Decimal.zero();
    return {
      outcome: "propose_sell",
      stage: next.stage,
      quantity,
      zone,
      reasonCode: `STAGE_${next.stage}_EXECUTION_ZONE_REACHED`,
    };
  }
}


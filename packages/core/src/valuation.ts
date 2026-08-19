import { createHash } from "node:crypto";
import { Decimal } from "./decimal.js";

export type GateState = "clear" | "yellow" | "red";

export type EvidenceScore = 0 | 1 | 2 | 3 | 4 | "unknown";

export interface WeightedCriterion {
  name: string;
  weight: number;
  score: EvidenceScore;
  critical: boolean;
}

export interface TrackScore {
  score?: number; // 0-100
  hasUnknown: boolean;
  minimumCritical?: number;
}

export function scoreTrack(criteria: WeightedCriterion[]): TrackScore {
  const hasUnknown = criteria.some((c) => c.score === "unknown");
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  let score: number | undefined;
  if (!hasUnknown && totalWeight > 0) {
    const weighted = criteria.reduce(
      (s, c) => s + c.weight * (c.score as number),
      0,
    );
    score = Math.floor((weighted * 100) / (totalWeight * 4));
  }
  const criticalScores = criteria
    .filter((c) => c.critical)
    .filter((c) => c.score !== "unknown")
    .map((c) => c.score as number);
  return {
    score,
    hasUnknown,
    minimumCritical: criticalScores.length > 0 ? Math.min(...criticalScores) : undefined,
  };
}

export type QualityBand = "research" | "qualified" | "high_quality" | "core";

export function qualityBand(combinedScore: number, minimumCritical: number): QualityBand {
  if (combinedScore >= 85 && minimumCritical >= 3) return "core";
  if (combinedScore >= 70 && minimumCritical >= 2) return "high_quality";
  if (combinedScore >= 60) return "qualified";
  return "research";
}

export interface LiLuAssessment {
  moat: EvidenceScore;
  incrementalRoic: EvidenceScore;
  cashConversion: EvidenceScore;
  managementAndAllocation: EvidenceScore;
  balanceSheet: EvidenceScore;
  runway: EvidenceScore;
}

export interface BurryAssessment {
  valuationDiscount: EvidenceScore;
  bearProtection: EvidenceScore;
  balanceSheet: EvidenceScore;
  normalizedFcf: EvidenceScore;
  expectationGap: EvidenceScore;
  catalyst: EvidenceScore;
}

export interface ValueAssessment {
  gate: GateState;
  liLu: LiLuAssessment;
  burry: BurryAssessment;
}

export interface AssessmentResult {
  liLuScore: TrackScore;
  burryScore: TrackScore;
  combinedScore?: number;
  band?: QualityBand;
  minimumPositionPercent: number;
  maximumPositionPercent: number;
  exitReviewRequired: boolean;
}

export function contentHash(assessment: ValueAssessment): string {
  return createHash("sha256").update(JSON.stringify(assessment)).digest("hex");
}

export function evaluate(assessment: ValueAssessment): AssessmentResult {
  const liLuScore = scoreTrack([
    { name: "moat", weight: 25, score: assessment.liLu.moat, critical: true },
    { name: "incremental_roic", weight: 25, score: assessment.liLu.incrementalRoic, critical: true },
    { name: "cash_conversion", weight: 15, score: assessment.liLu.cashConversion, critical: false },
    { name: "management_and_allocation", weight: 15, score: assessment.liLu.managementAndAllocation, critical: true },
    { name: "balance_sheet", weight: 10, score: assessment.liLu.balanceSheet, critical: true },
    { name: "runway", weight: 10, score: assessment.liLu.runway, critical: false },
  ]);
  const burryScore = scoreTrack([
    { name: "valuation_discount", weight: 25, score: assessment.burry.valuationDiscount, critical: true },
    { name: "bear_protection", weight: 25, score: assessment.burry.bearProtection, critical: true },
    { name: "balance_sheet", weight: 15, score: assessment.burry.balanceSheet, critical: true },
    { name: "normalized_fcf", weight: 15, score: assessment.burry.normalizedFcf, critical: true },
    { name: "expectation_gap", weight: 10, score: assessment.burry.expectationGap, critical: false },
    { name: "catalyst", weight: 10, score: assessment.burry.catalyst, critical: false },
  ]);

  let combinedScore: number | undefined;
  if (liLuScore.score !== undefined && burryScore.score !== undefined) {
    combinedScore = Math.floor((liLuScore.score + burryScore.score) / 2);
  }
  let minCritical: number | undefined;
  if (liLuScore.minimumCritical !== undefined && burryScore.minimumCritical !== undefined) {
    minCritical = Math.min(liLuScore.minimumCritical, burryScore.minimumCritical);
  }

  let band: QualityBand | undefined;
  if (combinedScore !== undefined && minCritical !== undefined) {
    band = qualityBand(combinedScore, minCritical);
  }

  let [minimumPositionPercent, maximumPositionPercent] = (() => {
    switch (band) {
      case "qualified": return [5, 15];
      case "high_quality": return [15, 30];
      case "core": return [30, 80];
      default: return [0, 5];
    }
  })();

  const exitReviewRequired = assessment.gate === "red";
  if (exitReviewRequired) {
    maximumPositionPercent = 0;
    minimumPositionPercent = 0;
  } else if (assessment.gate === "yellow") {
    maximumPositionPercent = Math.min(maximumPositionPercent, 25);
  }

  return {
    liLuScore,
    burryScore,
    combinedScore,
    band,
    minimumPositionPercent,
    maximumPositionPercent,
    exitReviewRequired,
  };
}

// ---- Guards ----

export interface ValuationGuard {
  gate: GateState;
  price: Decimal;
  baseValue: Decimal;
  baseIrr: Decimal;
  bearDownside: Decimal;
  balanceSheetSafe: boolean;
  fresh: boolean;
}

export function canAddRisk(g: ValuationGuard): boolean {
  return (
    g.gate !== "red" &&
    g.price.lt(g.baseValue) &&
    g.baseIrr.gte(Decimal.fromString("0.15")) &&
    g.bearDownside.lte(Decimal.fromString("0.25")) &&
    g.balanceSheetSafe &&
    g.fresh
  );
}

export interface CashDeploymentGuard {
  redLineClear: boolean;
  evidenceComplete: boolean;
  valuationCurrent: boolean;
  expectedIrr: Decimal;
  bearDownside: Decimal;
  balanceSheetSafe: boolean;
  liquidityReserveMet: boolean;
  resultingSingleNameWeight: Decimal;
}

export function canDeploy(g: CashDeploymentGuard): boolean {
  return (
    g.redLineClear &&
    g.evidenceComplete &&
    g.valuationCurrent &&
    g.expectedIrr.gte(Decimal.fromString("0.15")) &&
    g.bearDownside.lte(Decimal.fromString("0.25")) &&
    g.balanceSheetSafe &&
    g.liquidityReserveMet &&
    g.resultingSingleNameWeight.lte(Decimal.fromString("0.80"))
  );
}

// ---- Reverse DCF ----

export interface ReverseDcfSnapshot {
  profileId: string;
  instrumentId: string;
  asOf: string;
  reviewDue: string;
  enterpriseValue: Decimal;
  startingFreeCashFlow: Decimal;
  discountRate: Decimal; // fraction, e.g. 0.10
  terminalMultiple: Decimal;
  years: number;
  evidenceReference: string;
}

export function impliedFcfGrowth(s: ReverseDcfSnapshot): Decimal | undefined {
  if (
    s.enterpriseValue.lte(Decimal.zero()) ||
    s.startingFreeCashFlow.lte(Decimal.zero()) ||
    s.discountRate.lte(Decimal.fromString("-0.99")) ||
    s.terminalMultiple.isNegative() ||
    s.years === 0 ||
    s.reviewDue < s.asOf
  ) {
    return undefined;
  }

  const presentValue = (growth: Decimal): Decimal => {
    let fcf = s.startingFreeCashFlow;
    let discount = Decimal.one();
    let value = Decimal.zero();
    for (let i = 1; i <= s.years; i++) {
      fcf = fcf.mul(Decimal.one().add(growth));
      discount = discount.mul(Decimal.one().add(s.discountRate));
      value = value.add(fcf.div(discount));
    }
    return value.add(fcf.mul(s.terminalMultiple).div(discount));
  };

  let low = Decimal.fromString("-0.99");
  let high = Decimal.fromString("10");
  if (presentValue(low).gt(s.enterpriseValue) || presentValue(high).lt(s.enterpriseValue)) {
    return undefined;
  }
  for (let i = 0; i < 160; i++) {
    const mid = low.add(high).div(Decimal.fromString("2"));
    if (presentValue(mid).lt(s.enterpriseValue)) low = mid;
    else high = mid;
  }
  return low.add(high).div(Decimal.fromString("2"));
}

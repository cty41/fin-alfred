import { createHash } from "node:crypto";
import { Decimal } from "./decimal.js";

export interface DecisionSnapshot {
  profileId: string;
  strategyVersion: string;
  engineVersion: string;
  facts: Record<string, string>;
}

export function decisionKey(snapshot: DecisionSnapshot): string {
  const canonical = JSON.stringify({
    profile_id: snapshot.profileId,
    strategy_version: snapshot.strategyVersion,
    engine_version: snapshot.engineVersion,
    facts: Object.fromEntries(
      Object.entries(snapshot.facts).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export type RecommendationStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "partially_filled"
  | "filled"
  | "superseded"
  | "expired";

export class InvalidTransition extends Error {
  constructor(
    public readonly from: RecommendationStatus,
    public readonly to: RecommendationStatus,
  ) {
    super(`invalid recommendation transition from ${from} to ${to}`);
    this.name = "InvalidTransition";
  }
}

const VALID_TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
  proposed: ["accepted", "rejected", "superseded", "expired"],
  accepted: ["partially_filled", "filled", "superseded", "expired"],
  partially_filled: ["partially_filled", "filled", "superseded", "expired"],
  rejected: [],
  filled: [],
  superseded: [],
  expired: [],
};

export class Recommendation {
  readonly decisionKey: string;

  constructor(
    public readonly snapshot: DecisionSnapshot,
    public status: RecommendationStatus,
    public targetQuantity: Decimal,
    public filledQuantity: Decimal,
    public resolutionReason?: string,
    public supersededBy?: string,
  ) {
    this.decisionKey = decisionKey(snapshot);
  }

  static proposed(snapshot: DecisionSnapshot, targetQuantity: Decimal): Recommendation {
    return new Recommendation(snapshot, "proposed", targetQuantity, Decimal.zero());
  }

  private transition(next: RecommendationStatus): void {
    if (!VALID_TRANSITIONS[this.status].includes(next)) {
      throw new InvalidTransition(this.status, next);
    }
    this.status = next;
  }

  accept(): void {
    this.transition("accepted");
  }

  reject(reason: string): void {
    this.transition("rejected");
    this.resolutionReason = reason;
  }

  recordFill(quantity: Decimal): void {
    if (
      quantity.lte(Decimal.zero()) ||
      (this.status !== "accepted" && this.status !== "partially_filled")
    ) {
      throw new InvalidTransition(this.status, "partially_filled");
    }
    this.filledQuantity = this.filledQuantity.add(quantity);
    this.transition(this.filledQuantity.gte(this.targetQuantity) ? "filled" : "partially_filled");
  }

  supersede(replacementKey: string): void {
    this.transition("superseded");
    this.supersededBy = replacementKey;
  }

  replayIsDeterministic(): boolean {
    return this.decisionKey === decisionKey(this.snapshot);
  }
}

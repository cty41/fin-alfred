import { createHash } from "node:crypto";
import { Decimal, d } from "./decimal.js";

export type Side = "buy" | "sell";

export interface FeeBreakdown {
  stampDuty: Decimal;
  clearingFee: Decimal;
  transferFee: Decimal;
  commission: Decimal;
}

export function feeTotal(fees: FeeBreakdown): Decimal {
  return fees.stampDuty.add(fees.clearingFee).add(fees.transferFee).add(fees.commission);
}

export interface Execution {
  instrumentId: string;
  side: Side;
  tradedAt: string; // YYYY-MM-DD
  quantity: Decimal;
  price: Decimal;
  fees: FeeBreakdown;
  externalId?: string;
}

export function grossAmount(exec: Execution): Decimal {
  return exec.quantity.mul(exec.price);
}

export function netCashFlow(exec: Execution): Decimal {
  const gross = grossAmount(exec);
  const fees = feeTotal(exec.fees);
  return exec.side === "sell" ? gross.sub(fees) : gross.add(fees).neg();
}

export function executionKey(exec: Execution, profileId: string): string {
  const stable = [
    profileId,
    exec.instrumentId,
    exec.side,
    exec.tradedAt,
    exec.quantity.normalize(),
    exec.price.normalize(),
    exec.externalId ?? "",
  ].join("|");
  return createHash("sha256").update(stable).digest("hex");
}

export type LedgerErrorKind =
  | "InvalidExecution"
  | "InstrumentMismatch"
  | "InsufficientPosition"
  | "InsufficientCash";

export class LedgerError extends Error {
  constructor(public readonly kind: LedgerErrorKind, message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export type ApplyResult = "applied" | "duplicate";

export class Ledger {
  private appliedExecutionKeys = new Set<string>();

  constructor(
    public readonly profileId: string,
    public readonly instrumentId: string,
    public quantity: Decimal,
    public cash: Decimal,
  ) {}

  apply(exec: Execution): ApplyResult {
    if (exec.instrumentId !== this.instrumentId) {
      throw new LedgerError("InstrumentMismatch", "execution instrument does not match ledger");
    }
    if (
      exec.quantity.lte(Decimal.zero()) ||
      exec.price.lte(Decimal.zero()) ||
      exec.fees.stampDuty.isNegative() ||
      exec.fees.clearingFee.isNegative() ||
      exec.fees.transferFee.isNegative() ||
      exec.fees.commission.isNegative()
    ) {
      throw new LedgerError(
        "InvalidExecution",
        "execution quantity, price, and fees must be non-negative with positive quantity and price",
      );
    }
    const key = executionKey(exec, this.profileId);
    if (this.appliedExecutionKeys.has(key)) return "duplicate";

    const nextQuantity =
      exec.side === "sell" ? this.quantity.sub(exec.quantity) : this.quantity.add(exec.quantity);
    const nextCash = this.cash.add(netCashFlow(exec));
    if (nextQuantity.isNegative()) {
      throw new LedgerError("InsufficientPosition", "execution would make the position negative");
    }
    if (nextCash.isNegative()) {
      throw new LedgerError("InsufficientCash", "execution would make cash negative");
    }
    this.quantity = nextQuantity;
    this.cash = nextCash;
    this.appliedExecutionKeys.add(key);
    return "applied";
  }

  appliedKeys(): readonly string[] {
    return [...this.appliedExecutionKeys];
  }
}

export { d };

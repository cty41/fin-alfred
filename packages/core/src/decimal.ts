/**
 * Fixed-point decimal backed by bigint.
 * Scale is 8 decimal places — sufficient for prices, percentages, and share quantities.
 */
const SCALE = 8n;
const SCALE_NUM = 100_000_000n;

export class Decimal {
  readonly raw: bigint;

  private constructor(raw: bigint) {
    this.raw = raw;
  }

  static fromString(s: string): Decimal {
    s = s.trim();
    const negative = s.startsWith("-");
    if (negative) s = s.slice(1);
    const parts = s.split(".");
    if (parts.length > 2) throw new Error(`Invalid decimal: ${s}`);
    const intPart = BigInt(parts[0] || "0");
    let fracPart = 0n;
    if (parts.length === 2) {
      const fracStr = (parts[1] + "00000000").slice(0, 8);
      fracPart = BigInt(fracStr);
    }
    let raw = intPart * SCALE_NUM + fracPart;
    if (negative) raw = -raw;
    return new Decimal(raw);
  }

  static fromNumber(n: number): Decimal {
    return Decimal.fromString(n.toString());
  }

  static fromBigInt(n: bigint): Decimal {
    return new Decimal(n * SCALE_NUM);
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }

  static one(): Decimal {
    return new Decimal(SCALE_NUM);
  }

  static percent(n: number): Decimal {
    return Decimal.fromString((n / 100).toFixed(8));
  }

  add(other: Decimal): Decimal {
    return new Decimal(this.raw + other.raw);
  }

  sub(other: Decimal): Decimal {
    return new Decimal(this.raw - other.raw);
  }

  mul(other: Decimal): Decimal {
    return new Decimal((this.raw * other.raw) / SCALE_NUM);
  }

  div(other: Decimal): Decimal {
    if (other.raw === 0n) throw new Error("Division by zero");
    return new Decimal((this.raw * SCALE_NUM) / other.raw);
  }

  neg(): Decimal {
    return new Decimal(-this.raw);
  }

  abs(): Decimal {
    return this.raw < 0n ? this.neg() : this;
  }

  isZero(): boolean {
    return this.raw === 0n;
  }

  isNegative(): boolean {
    return this.raw < 0n;
  }

  isPositive(): boolean {
    return this.raw > 0n;
  }

  lt(other: Decimal): boolean {
    return this.raw < other.raw;
  }

  lte(other: Decimal): boolean {
    return this.raw <= other.raw;
  }

  gt(other: Decimal): boolean {
    return this.raw > other.raw;
  }

  gte(other: Decimal): boolean {
    return this.raw >= other.raw;
  }

  eq(other: Decimal): boolean {
    return this.raw === other.raw;
  }

  max(other: Decimal): Decimal {
    return this.gte(other) ? this : other;
  }

  min(other: Decimal): Decimal {
    return this.lte(other) ? this : other;
  }

  toNumber(): number {
    return Number(this.raw) / Number(SCALE_NUM);
  }

  toString(): string {
    return this.toFixed(8).replace(/\.?0+$/, "") || "0";
  }

  toFixed(dp: number): string {
    if (dp < 0 || dp > 8) throw new Error("toFixed: dp must be 0..8");
    const negative = this.raw < 0n;
    const abs = negative ? -this.raw : this.raw;
    const divisor = 10n ** BigInt(8 - dp);
    const rounded = (abs + divisor / 2n) / divisor;
    const intPart = rounded / 10n ** BigInt(dp);
    const fracPart = rounded % 10n ** BigInt(dp);
    const fracStr = dp > 0 ? "." + fracPart.toString().padStart(dp, "0") : "";
    return (negative ? "-" : "") + intPart.toString() + fracStr;
  }

  normalize(): string {
    return this.toString();
  }

  toJSON(): string {
    return this.toString();
  }
}

export function d(value: string | number | bigint): Decimal {
  if (typeof value === "bigint") return Decimal.fromBigInt(value);
  if (typeof value === "number") return Decimal.fromNumber(value);
  return Decimal.fromString(value);
}

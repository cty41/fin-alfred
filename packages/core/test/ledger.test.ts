import { describe, it, expect } from "vitest";
import { Decimal, d } from "@fin-alfred/core";
import { Ledger, executionKey, grossAmount, netCashFlow, feeTotal } from "@fin-alfred/core";

const ZERO_FEES = { stampDuty: d("0"), clearingFee: d("0"), transferFee: d("0"), commission: d("0") };

function xiaomiExecution() {
  return {
    instrumentId: "HKEX:1810",
    side: "sell" as const,
    tradedAt: "2026-08-14",
    quantity: d("12000"),
    price: d("25.62"),
    fees: {
      stampDuty: d("270"),
      clearingFee: d("22"),
      transferFee: d("11"),
      commission: d("26"),
    },
  };
}

describe("Ledger - Xiaomi real execution", () => {
  it("balances correctly", () => {
    const exec = xiaomiExecution();
    expect(grossAmount(exec).toString()).toBe("307440");
    expect(feeTotal(exec.fees).toString()).toBe("329");
    expect(netCashFlow(exec).toString()).toBe("307111");

    const ledger = new Ledger("profile-xiaomi-real", "HKEX:1810", d("225600"), d("87889"));
    expect(ledger.apply(exec)).toBe("applied");
    expect(ledger.quantity.toString()).toBe("213600");
    expect(ledger.cash.toString()).toBe("395000");
  });

  it("duplicate execution is idempotent", () => {
    const exec = xiaomiExecution();
    const ledger = new Ledger("profile-xiaomi-real", "HKEX:1810", d("225600"), d("87889"));
    ledger.apply(exec);
    expect(ledger.apply(exec)).toBe("duplicate");
    expect(ledger.quantity.toString()).toBe("213600");
    expect(ledger.cash.toString()).toBe("395000");
  });

  it("rejects over-selling", () => {
    const ledger = new Ledger("p", "HKEX:1810", d("100"), d("0"));
    const exec = { ...xiaomiExecution(), quantity: d("200") };
    expect(() => ledger.apply(exec)).toThrow(/negative/);
  });

  it("execution key is deterministic", () => {
    const exec = xiaomiExecution();
    const k1 = executionKey(exec, "p");
    const k2 = executionKey(exec, "p");
    expect(k1).toBe(k2);
    const k3 = executionKey(exec, "other");
    expect(k1).not.toBe(k3);
  });
});

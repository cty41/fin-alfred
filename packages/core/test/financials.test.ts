import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_MAPPING,
  accountMappingFor,
  enterpriseValueBreakdown,
  enterpriseValueFromAccounts,
  latestReportDate,
  sumMappedAccount,
  summarizeBalanceSheet,
  type RawStatementRow,
} from "../src/financials.js";
import { Decimal } from "../src/decimal.js";

function row(stdItemName: string, amount: number, reportDate = "2026-06-30"): RawStatementRow {
  return { stdItemName, amount, reportDate, stdItemCode: "x" };
}

describe("financial statement account mapping", () => {
  it("sums balance rows by canonical account substring", () => {
    const rows = [
      row("现金及等价物", 100),
      row("短期存款", 50),
      row("长期贷款", 200),
      row("存货", 30),
    ];
    const cash = sumMappedAccount(rows, DEFAULT_ACCOUNT_MAPPING.cashAndEquivalents);
    const debt = sumMappedAccount(rows, DEFAULT_ACCOUNT_MAPPING.interestBearingDebt);
    expect(cash.toString()).toBe("150");
    expect(debt.toString()).toBe("200");
  });

  it("summarizes the latest balance sheet report only", () => {
    const rows = [
      row("现金及等价物", 100, "2026-06-30"),
      row("现金及等价物", 80, "2025-12-31"),
      row("短期贷款", 90, "2026-06-30"),
      row("总资产", 1000, "2026-06-30"),
      row("总负债", 500, "2026-06-30"),
      row("股东权益", 450, "2026-06-30"),
      row("少数股东权益", 50, "2026-06-30"),
    ];
    const summary = summarizeBalanceSheet(rows, DEFAULT_ACCOUNT_MAPPING);
    expect(summary.cashAndEquivalents.toString()).toBe("100");
    expect(summary.interestBearingDebt.toString()).toBe("90");
    expect(summary.totalAssets.toString()).toBe("1000");
    expect(summary.totalEquity.toString()).toBe("450");
    expect(summary.minorityInterest.toString()).toBe("50");
  });

  it("does not double-count subtotal rows for totals and equity", () => {
    // Mirrors Tencent's real balance sheet: intermediate subtotals such as
    // "流动负债合计", "总资产减流动负债", and "总权益及总负债" must not be
    // absorbed into totalAssets/totalLiabilities/totalEquity.
    const rows = [
      row("流动资产合计", 300),
      row("非流动资产合计", 500),
      row("总资产", 800),
      row("流动负债合计", 200),
      row("非流动负债合计", 100),
      row("总负债", 300),
      row("总资产减流动负债", 600),
      row("股东权益", 450),
      row("少数股东权益", 50),
      row("总权益及总负债", 800),
    ];
    const summary = summarizeBalanceSheet(rows, DEFAULT_ACCOUNT_MAPPING);
    expect(summary.totalAssets.toString()).toBe("800");
    expect(summary.totalLiabilities.toString()).toBe("300");
    expect(summary.totalEquity.toString()).toBe("450");
    expect(summary.minorityInterest.toString()).toBe("50");
  });

  it("computes enterprise value via the equity-side bridge", () => {
    const accounts = {
      cashAndEquivalents: Decimal.fromString("100"),
      investments: Decimal.fromString("0"),
      interestBearingDebt: Decimal.fromString("200"),
      minorityInterest: Decimal.fromString("50"),
      totalAssets: Decimal.fromString("1000"),
      totalLiabilities: Decimal.fromString("500"),
      totalEquity: Decimal.fromString("450"),
    };
    // EV = equity + minority + debt - cash = 450 + 50 + 200 - 100 = 600
    expect(enterpriseValueFromAccounts(accounts).toString()).toBe("600");
    // net cash = cash + investments - debt = 100 + 0 - 200 = -100
    expect(enterpriseValueBreakdown(accounts).netCash.toString()).toBe("-100");
  });

  it("accepts a market equity value override for EV", () => {
    const accounts = {
      cashAndEquivalents: Decimal.fromString("100"),
      investments: Decimal.fromString("0"),
      interestBearingDebt: Decimal.fromString("200"),
      minorityInterest: Decimal.fromString("50"),
      totalAssets: Decimal.fromString("1000"),
      totalLiabilities: Decimal.fromString("500"),
      totalEquity: Decimal.fromString("450"),
    };
    const marketEquity = Decimal.fromString("9000");
    expect(enterpriseValueFromAccounts(accounts, marketEquity).toString()).toBe("9150");
  });

  it("falls back to the default mapping for unlisted instruments", () => {
    expect(accountMappingFor("HKEX:0700")).toStrictEqual(DEFAULT_ACCOUNT_MAPPING);
  });

  it("returns the newest report date", () => {
    const rows = [row("现金及等价物", 1, "2025-12-31"), row("现金及等价物", 1, "2026-06-30")];
    expect(latestReportDate(rows)).toBe("2026-06-30");
  });
});

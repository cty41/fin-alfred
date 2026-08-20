import { Decimal } from "./decimal.js";

/**
 * Financial-statement domain model for HK-listed companies sourced from the
 * Eastmoney F10 three-statement tables.
 *
 * The upstream tables (RPT_HKF10_FN_BALANCE_PC / _INCOME_PC / _CASHFLOW_PC)
 * expose non-uniform, company-specific Chinese account names. This module maps
 * those raw names into a small set of stable "standard accounts" used for
 * enterprise-value and intrinsic-value reasoning, while always preserving the
 * raw rows so the mapping remains auditable.
 */

export type StatementKind = "balance" | "income" | "cashflow";

/** A single raw row from the Eastmoney F10 statement table. */
export interface RawStatementRow {
  secucode?: string;
  securityCode?: string;
  securityNameAbbr?: string;
  orgCode?: string;
  reportDate?: string;
  dateTypeCode?: string;
  fiscalYear?: string;
  startDate?: string;
  stdItemCode?: string;
  stdItemName?: string;
  amount?: number | null;
  stdReportDate?: string;
}

export interface RawStatement {
  kind: StatementKind;
  /** Report dates available for this statement, newest first. */
  reportDates: string[];
  /** Raw rows exactly as returned by the provider (audit trail). */
  rows: RawStatementRow[];
}

/**
 * Stable standard accounts used for valuation. Values are absolute amounts in
 * the statement's native currency (CNY / 人民币 for these listings).
 */
export interface StandardAccounts {
  /** Cash, bank balances and short-term deposits (including restricted). */
  cashAndEquivalents: Decimal;
  /** Fair-value financial assets, associates, joint ventures, investment properties, and securities. */
  investments: Decimal;
  /** Interest-bearing debt: short/long-term loans, notes, bonds, finance leases. */
  interestBearingDebt: Decimal;
  /** Minority interest (non-controlling interests). */
  minorityInterest: Decimal;
  /** Total assets. */
  totalAssets: Decimal;
  /** Total liabilities. */
  totalLiabilities: Decimal;
  /** Total equity attributable to owners. */
  totalEquity: Decimal;
}

export interface StatementSummary {
  reportDate: string;
  currency?: string;
  balance?: StandardAccounts;
}

/**
 * A mapping from a semantic standard key to the set of Chinese account-name
 * substrings that imply it. Order matters: the first mapping in a group whose
 * substring matches a row claims that row for the standard account.
 *
 * Names are company-specific, so this is the "versioned default" layer: commit
 * edits with a matching test when an instrument's accounts change.
 */
export interface AccountMapping {
  /** Balance-sheet standard accounts keyed by standard account name. */
  cashAndEquivalents: string[];
  investments: string[];
  interestBearingDebt: string[];
  minorityInterest: string[];
  totalAssets: string[];
  totalLiabilities: string[];
  totalEquity: string[];
}

/**
 * Default mapping shared across the supported HK listings. Company-specific
 * overrides merge on top for the instruments whose accounts diverge (Tencent's
 * "联营公司权益"/"应付票据", Alibaba's "证券投资"/"可转换票据及债券", etc.).
 *
 * Aggregate groups (cash, investments, debt) match by substring, because they
 * collect several distinct rows. Totals (assets/liabilities/equity) and
 * minority interest match by EXACT item name, because the tables contain
 * intermediate subtotals such as "流动负债合计", "总资产减流动负债", and
 * "总权益及总负债" that would otherwise be double-counted.
 */
export const DEFAULT_ACCOUNT_MAPPING: AccountMapping = {
  cashAndEquivalents: ["现金及等价物", "现金及现金等价物", "短期存款", "中长期存款", "受限制存款", "银行存款"],
  investments: [
    "指定以公允价值记账之金融资产",
    "以公允价值计量且其变动计入损益",
    "联营公司权益",
    "合营公司权益",
    "投资物业",
    "短期投资",
    "长期投资",
    "证券投资",
    "其他投资",
  ],
  interestBearingDebt: [
    "短期贷款",
    "长期贷款",
    "借款",
    "应付票据",
    "融资租赁负债",
    "可转换票据",
    "债券",
    "贷款及垫款",
  ],
  minorityInterest: ["少数股东权益", "非控股权益"],
  totalAssets: ["总资产", "资产总计"],
  totalLiabilities: ["总负债"],
  totalEquity: ["股东权益", "权益总额", "股东权益合计", "归属母公司股东权益", "股东应占权益"],
};

/**
 * Instrument-level overrides merged on top of the default mapping. Keys are
 * normalization-stable instrument IDs (HKEX:XXXX). A `null` value means "this
 * standard account is not derivable for this instrument from the raw rows".
 */
export const INSTRUMENT_ACCOUNT_OVERRIDES: Record<string, Partial<AccountMapping>> = {
  // Tencent: unique associate/JV and notes-payable structure is already covered
  // by the default mapping; no override required.
};

/**
 * Resolve the effective account mapping for an instrument.
 */
export function accountMappingFor(instrumentId: string): AccountMapping {
  const overrides = INSTRUMENT_ACCOUNT_OVERRIDES[instrumentId] ?? {};
  return {
    cashAndEquivalents: overrides.cashAndEquivalents ?? DEFAULT_ACCOUNT_MAPPING.cashAndEquivalents,
    investments: overrides.investments ?? DEFAULT_ACCOUNT_MAPPING.investments,
    interestBearingDebt: overrides.interestBearingDebt ?? DEFAULT_ACCOUNT_MAPPING.interestBearingDebt,
    minorityInterest: overrides.minorityInterest ?? DEFAULT_ACCOUNT_MAPPING.minorityInterest,
    totalAssets: overrides.totalAssets ?? DEFAULT_ACCOUNT_MAPPING.totalAssets,
    totalLiabilities: overrides.totalLiabilities ?? DEFAULT_ACCOUNT_MAPPING.totalLiabilities,
    totalEquity: overrides.totalEquity ?? DEFAULT_ACCOUNT_MAPPING.totalEquity,
  };
}

/**
 * Sum the AMOUNT of balance rows whose item name matches the mapped names.
 * By default matches by substring (for multi-row aggregate groups); pass
 * `exact = true` for total/summary anchors that must not absorb intermediate
 * subtotals. Rows with a null amount are ignored. Returns Decimal.zero() when
 * no match.
 */
export function sumMappedAccount(
  rows: RawStatementRow[],
  names: string[],
  exact = false,
): Decimal {
  let total = Decimal.zero();
  for (const row of rows) {
    const name = row.stdItemName ?? "";
    const amount = row.amount;
    if (amount == null || !Number.isFinite(amount)) continue;
    const matched = exact ? names.includes(name) : names.some((s) => name.includes(s));
    if (matched) total = total.add(Decimal.fromNumber(amount));
  }
  return total;
}

/**
 * Build the standard-account summary for the latest balance-sheet report.
 */
export function summarizeBalanceSheet(
  balanceRows: RawStatementRow[],
  mapping: AccountMapping,
): StandardAccounts {
  const latest = latestReportDate(balanceRows);
  const rows = latest ? balanceRows.filter((r) => r.reportDate === latest) : balanceRows;
  return {
    cashAndEquivalents: sumMappedAccount(rows, mapping.cashAndEquivalents),
    investments: sumMappedAccount(rows, mapping.investments),
    interestBearingDebt: sumMappedAccount(rows, mapping.interestBearingDebt),
    minorityInterest: sumMappedAccount(rows, mapping.minorityInterest, true),
    totalAssets: sumMappedAccount(rows, mapping.totalAssets, true),
    totalLiabilities: sumMappedAccount(rows, mapping.totalLiabilities, true),
    totalEquity: sumMappedAccount(rows, mapping.totalEquity, true),
  };
}

/** Newest report date string across the rows, or undefined when empty. */
export function latestReportDate(rows: RawStatementRow[]): string | undefined {
  let latest: string | undefined;
  for (const row of rows) {
    if (!row.reportDate) continue;
    if (latest === undefined || row.reportDate > latest) latest = row.reportDate;
  }
  return latest;
}

/**
 * Compute enterprise value from a standard-account balance summary.
 * EV = equity + minority interest + interest-bearing debt − cash and equivalents.
 * This is the equity-side bridge; a market-price equity value can be supplied
 * by the caller instead of book equity when available.
 */
export function enterpriseValueFromAccounts(
  accounts: StandardAccounts,
  marketEquityValue?: Decimal,
): Decimal {
  const equity = marketEquityValue ?? accounts.totalEquity;
  return equity
    .add(accounts.minorityInterest)
    .add(accounts.interestBearingDebt)
    .sub(accounts.cashAndEquivalents);
}

/** Standard enterprise-value breakdown used for strategy reasoning. */
export interface EnterpriseValueBreakdown {
  equity: Decimal;
  minorityInterest: Decimal;
  interestBearingDebt: Decimal;
  cashAndEquivalents: Decimal;
  investments: Decimal;
  enterpriseValue: Decimal;
  /** Cash + investments − interest-bearing debt (net cash position, excluding minority interest). */
  netCash: Decimal;
}

export function enterpriseValueBreakdown(
  accounts: StandardAccounts,
  marketEquityValue?: Decimal,
): EnterpriseValueBreakdown {
  const equity = marketEquityValue ?? accounts.totalEquity;
  const netCash = accounts.cashAndEquivalents
    .add(accounts.investments)
    .sub(accounts.interestBearingDebt);
  return {
    equity,
    minorityInterest: accounts.minorityInterest,
    interestBearingDebt: accounts.interestBearingDebt,
    cashAndEquivalents: accounts.cashAndEquivalents,
    investments: accounts.investments,
    enterpriseValue: enterpriseValueFromAccounts(accounts, marketEquityValue),
    netCash,
  };
}

import { createHash } from "node:crypto";
import { Decimal } from "./decimal.js";

export interface PriceSnapshot {
  price: Decimal;
  previousClose?: Decimal;
  observedAt: string;
  source: string;
}

export interface InstrumentProfile {
  instrumentId: string;
  symbol: string;
  name: string;
  currency: string;
  announcementUrl: string;
  investorRelationsUrl: string;
  buyPrice?: Decimal;
  priceSnapshots: PriceSnapshot[];
  manualPriceOverride?: PriceSnapshot;
}

export interface AnnualFinancials {
  instrumentId: string;
  year: number;
  currency: string;
  revenue: Decimal;
  netIncome: Decimal;
  cash: Decimal;
  debt: Decimal;
  equity: Decimal;
  operatingCashFlow: Decimal;
  capex: Decimal;
  sourceUrl: string;
  updatedAt: string;
}

export interface DcfScenarioInput {
  revenueGrowth: Decimal; // fraction per year
  endingNetMargin: Decimal; // fraction
  cashConversion: Decimal; // fraction of net income -> FCFE proxy
  discountRate: Decimal;
  exitPe: Decimal;
}

export interface DcfInput {
  instrumentId: string;
  startingRevenue: Decimal;
  startingNetMargin: Decimal;
  dilutedShares: Decimal;
  forecastYears: number;
  bear: DcfScenarioInput;
  base: DcfScenarioInput;
  bull: DcfScenarioInput;
  asOf: string;
}

export interface DcfProjectionRow {
  year: number;
  revenue: Decimal;
  netMargin: Decimal;
  netIncome: Decimal;
  fcfeProxy: Decimal;
  discountedFcfe: Decimal;
}

export interface DcfScenarioResult {
  valuePerShare: Decimal;
  pvForecastFcfe: Decimal;
  pvTerminalValue: Decimal;
  equityValue: Decimal;
  terminalValueShare: Decimal;
  projection: DcfProjectionRow[];
}

export interface DcfResult {
  input: DcfInput;
  bear: DcfScenarioResult;
  base: DcfScenarioResult;
  bull: DcfScenarioResult;
  contentHash: string;
}

export function runDcf(input: DcfInput): DcfResult {
  const run = (scenario: DcfScenarioInput): DcfScenarioResult => {
    const projection: DcfProjectionRow[] = [];
    let revenue = input.startingRevenue;
    let netMargin = input.startingNetMargin;
    let pvForecastFcfe = Decimal.zero();
    let lastFcfe = Decimal.zero();
    let discount = Decimal.one();

    for (let year = 1; year <= input.forecastYears; year++) {
      revenue = revenue.mul(Decimal.one().add(scenario.revenueGrowth));
      // Linear margin interpolation from starting to ending
      const progress = Decimal.fromString(year.toString()).div(Decimal.fromString(input.forecastYears.toString()));
      netMargin = input.startingNetMargin.add(scenario.endingNetMargin.sub(input.startingNetMargin).mul(progress));
      const netIncome = revenue.mul(netMargin);
      const fcfeProxy = netIncome.mul(scenario.cashConversion);
      discount = discount.mul(Decimal.one().add(scenario.discountRate));
      const discountedFcfe = fcfeProxy.div(discount);
      pvForecastFcfe = pvForecastFcfe.add(discountedFcfe);
      lastFcfe = fcfeProxy;
      projection.push({ year, revenue, netMargin, netIncome, fcfeProxy, discountedFcfe });
    }

    const terminalValue = lastFcfe.mul(scenario.exitPe);
    const pvTerminalValue = terminalValue.div(discount);
    const equityValue = pvForecastFcfe.add(pvTerminalValue);
    const valuePerShare = equityValue.div(input.dilutedShares);
    const total = pvForecastFcfe.add(pvTerminalValue);
    const terminalValueShare = total.isZero() ? Decimal.zero() : pvTerminalValue.div(total);

    return { valuePerShare, pvForecastFcfe, pvTerminalValue, equityValue, terminalValueShare, projection };
  };

  const bear = run(input.bear);
  const base = run(input.base);
  const bull = run(input.bull);
  const contentHash = createHash("sha256").update(JSON.stringify({ input, bear, base, bull })).digest("hex");
  return { input, bear, base, bull, contentHash };
}

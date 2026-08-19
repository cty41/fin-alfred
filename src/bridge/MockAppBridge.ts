import type { AppBridge } from "./AppBridge";
import type { AnnualFinancials, DcfInput, DcfResult, DiagnosticEvent, InstrumentProfile, RelativeInput, RelativeResult, StrategyComparison, StrategyCondition, StrategyDraftInput, StrategyMetricReference, ValuationHistorySnapshot } from "../domain/types";
import { xiaomiOverview } from "./mockData";

function compare(actual: number, operator: StrategyComparison, expected: number) {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return undefined;
  return operator === "less_than" ? actual < expected : operator === "less_or_equal" ? actual <= expected : operator === "greater_than" ? actual > expected : operator === "greater_or_equal" ? actual >= expected : actual === expected;
}

function metricValue(inputs: Record<string, unknown>, metric: StrategyMetricReference) {
  const value = inputs[metric.name];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (metric.value_type === "integer" && !Number.isInteger(value)) return undefined;
  if (metric.value_type === "percentage" && (value < 0 || value > 100)) return undefined;
  return value;
}

function evaluateStrategyCondition(condition: StrategyCondition, inputs: Record<string, unknown>, depth = 0): boolean | undefined {
  if (depth > 16) return undefined;
  if (condition.kind === "metric_comparison") { const value = inputs[condition.metric]; return typeof value === "number" ? compare(value, condition.operator, condition.value) : undefined; }
  if (condition.kind === "typed_metric_comparison" || condition.kind === "portfolio_constraint") { const value = metricValue(inputs, condition.metric); return value === undefined ? undefined : compare(value, condition.operator, condition.value); }
  if (condition.kind === "all" || condition.kind === "any") { const values = condition.conditions.map((item) => evaluateStrategyCondition(item, inputs, depth + 1)); if (values.some((value) => value === undefined)) return undefined; return condition.kind === "all" ? values.every(Boolean) : values.some(Boolean); }
  if (condition.kind === "human_confirmation") return typeof inputs[condition.checklist_id] === "boolean" ? inputs[condition.checklist_id] as boolean : undefined;
  if (condition.kind === "band") { const value = metricValue(inputs, condition.metric); return value === undefined ? undefined : (condition.minimum === undefined || value >= condition.minimum) && (condition.maximum === undefined || value <= condition.maximum); }
  if (condition.kind === "manual_checklist") return condition.items.every((item) => inputs[`${condition.checklist_id}.${item}`] === true);
  if (condition.kind === "time_comparison") { const actual = inputs[condition.field]; if (typeof actual !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(actual)) return undefined; return condition.operator === "before" ? actual < condition.value : condition.operator === "on_or_before" ? actual <= condition.value : condition.operator === "after" ? actual > condition.value : condition.operator === "on_or_after" ? actual >= condition.value : actual === condition.value; }
  if (condition.kind !== "state_machine") return undefined;
  const current = inputs[condition.machine_id];
  if (typeof current !== "string" || !condition.states.includes(current)) return undefined;
  return condition.transitions.filter((item) => item.from === current).some((item) => evaluateStrategyCondition(item.when, inputs, depth + 1) === true);
}

function strategyScenariosPass(strategy: StrategyDraftInput) {
  return strategy.test_scenarios.length > 0 && strategy.test_scenarios.every((scenario) => {
    const actual = evaluateStrategyCondition(strategy.condition, scenario.inputs);
    const actualAction = actual === true ? strategy.suggestion.action : undefined;
    return scenario.name.trim() !== "" && actual === scenario.expected_match && actualAction === scenario.expected_action;
  });
}

function mockDcf(input: DcfInput): DcfResult {
  const project = (scenario: DcfInput["base"]) => {
    let revenue = Number(input.startingRevenue); let pv = 0; let finalIncome = 0;
    const projection = Array.from({ length: input.forecastYears }, (_, index) => {
      const year = index + 1; revenue *= 1 + Number(scenario.revenueGrowth);
      const margin = Number(input.startingNetMargin) + (Number(scenario.endingNetMargin) - Number(input.startingNetMargin)) * year / input.forecastYears;
      const income = revenue * margin; const fcfe = income * Number(scenario.cashConversion); const discounted = fcfe / ((1 + Number(scenario.discountRate)) ** year);
      pv += discounted; finalIncome = income;
      return { year, revenue: String(revenue), netMargin: String(margin), netIncome: String(income), fcfeProxy: String(fcfe), discountedFcfe: String(discounted) };
    });
    const terminal = finalIncome * Number(scenario.exitPe) / ((1 + Number(scenario.discountRate)) ** input.forecastYears); const equity = pv + terminal;
    return { valuePerShare: String(equity / Number(input.dilutedShares)), pvForecastFcfe: String(pv), pvTerminalValue: String(terminal), equityValue: String(equity), terminalValueShare: String(terminal / equity), projection };
  };
  return { input: structuredClone(input), bear: project(input.bear), base: project(input.base), bull: project(input.bull), contentHash: JSON.stringify(input) };
}

function mockRelativeInput(instrumentId: string): RelativeInput {
  return { instrumentId, normalizedEps: "1.65", normalizedOcfPerShare: "1.5", pe: { current: "18.2", threeYearMedian: "22", fiveYearMedian: "20", peerMedian: "24", validObservations: 520, percentile10: "13", percentile90: "31" }, pcf: { current: "15.1", threeYearMedian: "25", fiveYearMedian: "23", peerMedian: "27", validObservations: 510, percentile10: "12", percentile90: "34" }, peers: [], source: "AKShare / demo", fetchedAt: new Date().toISOString(), asOf: new Date().toISOString().slice(0, 10) };
}

function mockRelative(input: RelativeInput): RelativeResult {
  const impliedPrices = ([...[input.pe.threeYearMedian, input.pe.fiveYearMedian, input.pe.peerMedian].map((multiple, index) => ({ metric: "P/E", reference: ["3Y Median", "5Y Median", "Peer Median"][index], multiple, basis: input.normalizedEps })), ...[input.pcf.threeYearMedian, input.pcf.fiveYearMedian, input.pcf.peerMedian].map((multiple, index) => ({ metric: "P/CF", reference: ["3Y Median", "5Y Median", "Peer Median"][index], multiple, basis: input.normalizedOcfPerShare }))]).filter((item) => Number(item.multiple) > 0 && Number(item.basis) > 0).map((item) => ({ metric: item.metric, reference: item.reference, multiple: item.multiple!, price: String(Number(item.multiple) * Number(item.basis)) }));
  const values = impliedPrices.map((item) => Number(item.price)).sort((a, b) => a - b); const middle = values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : undefined;
  return { input: structuredClone(input), bear: middle === undefined ? null : String(middle * .8), base: middle === undefined ? null : String(middle), bull: middle === undefined ? null : String(middle * 1.2), confidence: values.length >= 4 ? "normal" : values.length ? "low" : "insufficient", impliedPrices, contentHash: JSON.stringify(input) };
}

function sampleDcfInput(instrumentId: string): DcfInput {
  return {
    instrumentId, startingRevenue: "365906", startingNetMargin: "0.058", dilutedShares: "25000", forecastYears: 5,
    bear: { revenueGrowth: "0.04", endingNetMargin: "0.06", cashConversion: "0.85", discountRate: "0.11", exitPe: "12" },
    base: { revenueGrowth: "0.09", endingNetMargin: "0.082", cashConversion: "0.95", discountRate: "0.09", exitPe: "17" },
    bull: { revenueGrowth: "0.14", endingNetMargin: "0.10", cashConversion: "1", discountRate: "0.08", exitPe: "22" },
    asOf: "2026-08-18",
  };
}

export class MockAppBridge implements AppBridge {
  readonly mode = "mock" as const;
  private profiles = [{ id: xiaomiOverview.profileId, name: xiaomiOverview.profileName }];
  private strategies: Parameters<AppBridge["saveStrategyDraft"]>[1][] = [];
  private ledgerOverrides = new Map<string, { quantity: string; cash: string }>();
  private instruments: InstrumentProfile[] = [{ instrumentId: "HKEX:1810", symbol: "01810", name: "小米集团-W", currency: "HKD", announcementUrl: "https://www1.hkexnews.hk/", investorRelationsUrl: "https://ir.mi.com/", buyPrice: "25.62", priceSnapshots: [22.8, 23.4, 24.1, 23.7, 25.4].map((price, index) => ({ price: String(price), previousClose: index ? String([22.8, 23.4, 24.1, 23.7][index - 1]) : null, observedAt: `2026-08-${String(10 + index).padStart(2, "0")}T16:00:00+08:00`, source: "AKShare / demo" })), manualPriceOverride: null }];
  private financials: AnnualFinancials[] = [];
  private dcf: DcfResult = mockDcf(sampleDcfInput("HKEX:1810"));
  private relative: RelativeResult = mockRelative(mockRelativeInput("HKEX:1810"));
  private valuationHistory: ValuationHistorySnapshot[] = ["2020-12-31", "2021-12-31", "2022-12-30", "2023-12-29", "2024-12-31"].map((asOf, index) => ({ asOf, reportPeriod: asOf, marketPrice: ["31.9", "18.6", "10.9", "16.7", "34.2"][index], dcf: mockDcf({ ...sampleDcfInput("HKEX:1810"), asOf }), sourceUrl: "Xiaomi annual reports", createdAt: "2026-08-18T00:00:00Z" }));
  private diagnostics: DiagnosticEvent[] = [
    { id: "mock-2", timestamp: "2026-08-18T05:27:56Z", level: "WARN" as const, component: "akshare", operation: "refresh_watchlist_prices", result: "ok", message: "Eastmoney unavailable; fallback to Sina completed", correlationId: "mock-refresh", durationMs: 1514, source: "AKShare / Sina", fallbackUsed: true },
    { id: "mock-1", timestamp: "2026-08-18T05:27:55Z", level: "INFO" as const, component: "gateway", operation: "startup", result: "ok", message: "Gateway listening on loopback", correlationId: "startup", durationMs: null, source: null, fallbackUsed: false },
  ];

  async listWatchlist() { return this.instruments.map((instrument) => ({ instrument: structuredClone(instrument), lastPrice: instrument.priceSnapshots.at(-1)?.price, previousClose: instrument.priceSnapshots.at(-1)?.previousClose, priceSource: instrument.priceSnapshots.at(-1)?.source, manualOverride: false, priceHistory: instrument.priceSnapshots.map((item) => item.price), dcfBase: this.dcf?.base.valuePerShare ?? "50.71", relativeBase: this.relative?.base ?? "42.30" })); }
  async saveInstrument(_profileId: string, instrument: InstrumentProfile) { const existing = this.instruments.findIndex((item) => item.instrumentId === instrument.instrumentId); if (existing >= 0) this.instruments[existing] = structuredClone(instrument); else this.instruments.push(structuredClone(instrument)); return structuredClone(instrument); }
  async removeWatchlistInstrument(_profileId: string, instrumentId: string) { const before = this.instruments.length; this.instruments = this.instruments.filter((item) => item.instrumentId !== instrumentId); return { removed: before !== this.instruments.length }; }
  async refreshWatchlistPrices() { return { updated: this.instruments.length, fetchedAt: new Date().toISOString() }; }
  async getInstrumentSummary(profileId: string, instrumentId: string) { const instrument = this.instruments.find((item) => item.instrumentId === instrumentId); if (!instrument) throw new Error("instrument is not in this profile"); return { instrument: structuredClone(instrument), price: instrument.priceSnapshots.at(-1), financials: structuredClone(this.financials.filter((item) => item.instrumentId === instrumentId)), dcf: this.dcf ?? null, relative: this.relative ?? null, valuationHistory: structuredClone(this.valuationHistory), ledger: instrumentId === "HKEX:1810" ? { profileId, instrumentId, quantity: "213600", cash: "395000", currency: "HKD" } : null, stageOneCompleted: instrumentId === "HKEX:1810" }; }
  async listAnnualFinancials(_profileId: string, instrumentId: string) { return structuredClone(this.financials.filter((item) => item.instrumentId === instrumentId)); }
  async saveAnnualFinancials(_profileId: string, financials: AnnualFinancials) { this.financials = this.financials.filter((item) => !(item.instrumentId === financials.instrumentId && item.year === financials.year)); this.financials.push(structuredClone(financials)); return structuredClone(financials); }
  async previewDcf(_profileId: string, input: DcfInput) { return mockDcf(input); }
  async saveDcf(_profileId: string, input: DcfInput) { const result = mockDcf(input); const inserted = this.dcf?.contentHash !== result.contentHash; this.dcf = result; if (inserted && !this.valuationHistory.some((item) => item.dcf.contentHash === result.contentHash && item.asOf === input.asOf)) this.valuationHistory.push({ asOf: input.asOf, reportPeriod: input.asOf, marketPrice: this.instruments[0].priceSnapshots.at(-1)?.price ?? "", dcf: result, sourceUrl: "User saved DCF model", createdAt: new Date().toISOString() }); return { inserted, result }; }
  async refreshRelativeData(_profileId: string, instrumentId: string) { const input = this.relative?.input ?? mockRelativeInput(instrumentId); this.relative = mockRelative(input); return structuredClone(input); }
  async previewRelativeValuation(_profileId: string, input: RelativeInput) { return mockRelative(input); }
  async saveRelativeValuation(_profileId: string, input: RelativeInput) { const result = mockRelative(input); const inserted = this.relative?.contentHash !== result.contentHash; this.relative = result; return { inserted, result }; }

  async getOverview(profileId = xiaomiOverview.profileId) {
    const profile = this.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("投资档案不存在");
    const overview = structuredClone(xiaomiOverview);
    if (profile.id !== xiaomiOverview.profileId) {
      overview.profileId = profile.id;
      overview.profileName = profile.name;
      overview.initialQuantity = "0";
      overview.currentQuantity = "0";
      overview.cash.amount = "0";
      const ledger = this.ledgerOverrides.get(profile.id);
      if (ledger) { overview.currentQuantity = ledger.quantity; overview.initialQuantity = ledger.quantity; overview.cash.amount = ledger.cash; }
      overview.transaction = undefined;
      overview.stages = overview.stages.map((stage) => ({ ...stage, cumulativeTargetQuantity: "0", actualCumulativeQuantity: "0", status: "blocked" as const, nextRequirement: "先录入并核验该档案的初始持仓" }));
    }
    return overview;
  }

  async getProfileActivity(profileId: string) {
    const overview = await this.getOverview(profileId);
    const transaction = overview.transaction;
    return {
      ledger: { profileId, instrumentId: overview.instrumentId, quantity: overview.currentQuantity, cash: overview.cash.amount, currency: "HKD" },
      executions: transaction ? [{ executionKey: transaction.executionKey, profileId, instrumentId: transaction.instrumentId, side: transaction.side, tradedAt: transaction.tradedAt, quantity: transaction.quantity, price: transaction.price.amount, grossAmount: transaction.grossAmount.amount, netCashFlow: transaction.netCashFlow.amount, stampDuty: transaction.fees.stampDuty.amount, clearingFee: transaction.fees.clearingFee.amount, transferFee: transaction.fees.transferFee.amount, commission: transaction.fees.commission.amount, createdAt: transaction.tradedAt }] : [],
      decisions: [], audits: [],
    };
  }
  async initializeLedgerBaseline(profileId: string, quantity: string, cash: string) { if (this.ledgerOverrides.has(profileId)) throw new Error("ledger baseline is already initialized"); this.ledgerOverrides.set(profileId, { quantity, cash }); return { profileId, instrumentId: "HKEX:1810", quantity, cash, currency: "HKD" }; }
  async recordManualExecution(input: Parameters<AppBridge["recordManualExecution"]>[0]) { const ledger = this.ledgerOverrides.get(input.profileId); if (!ledger) throw new Error("请先建立账本基线"); const gross = Number(input.quantity) * Number(input.price); const fees = Number(input.stampDuty) + Number(input.clearingFee) + Number(input.transferFee) + Number(input.commission); const sign = input.side === "sell" ? 1 : -1; ledger.quantity = String(Number(ledger.quantity) - sign * Number(input.quantity)); ledger.cash = String(Number(ledger.cash) + sign * gross - fees); return { applied: true, ledger: { profileId: input.profileId, instrumentId: "HKEX:1810", quantity: ledger.quantity, cash: ledger.cash, currency: "HKD" }, executionKey: "mock-manual-execution" }; }
  async reviseExecutionFees(profileId: string) { const ledger = this.ledgerOverrides.get(profileId) ?? { quantity: "213600", cash: "395000" }; return { applied: true, cash: ledger.cash, quantity: ledger.quantity }; }

  async listProfiles() {
    return structuredClone(this.profiles);
  }

  async createProfile(name: string) {
    const item = { id: `profile-${crypto.randomUUID()}`, name: name.trim() };
    this.profiles.push(item);
    return structuredClone(item);
  }

  async exportProfileBackup(): Promise<Blob> {
    throw new Error("浏览器示例模式不能访问真实档案文件");
  }

  async importProfileBackup(): Promise<{ id: string; name: string }> {
    throw new Error("浏览器示例模式不能访问真实档案文件");
  }

  async evaluateXiaomiDecision(profileId: string, signals: Parameters<AppBridge["evaluateXiaomiDecision"]>[1]) {
    if (profileId !== xiaomiOverview.profileId) throw new Error("该档案尚未发布小米四阶段正式策略");
    if (signals.thesis_invalidated) return { outcome: { outcome: "exit_review" as const, reason_code: "THESIS_INVALIDATED_REVIEW_REQUIRED" }, recommendation: null };
    if (signals.fundamentals_strong && signals.market_crash) return { outcome: { outcome: "wait" as const, reason_code: "MARKET_CRASH_NO_MECHANICAL_SELL", missing_checks: [] }, recommendation: null };
    const missing = [!signals.rebound_confirmed_by_user && "user_confirmed_rebound", !signals.valuation_current && "current_valuation_and_quote", signals.fundamentals_deteriorated && "fundamentals_not_deteriorated"].filter(Boolean) as string[];
    if (missing.length) return { outcome: { outcome: "wait" as const, reason_code: "STAGE_2_CHECKLIST_INCOMPLETE", missing_checks: missing }, recommendation: null };
    return { outcome: { outcome: "propose_sell" as const, stage: 2, quantity: "10560.00", reason_code: "STAGE_2_REBOUND_GAP" }, recommendation: { decision_key: "mock-stage-2-decision", status: "proposed", target_quantity: "10560.00", filled_quantity: "0" } };
  }

  async acceptDecision() { return {}; }
  async rejectDecision() { return {}; }
  async replayDecision() { return true; }
  async saveManualQuote() { return true; }
  async saveSotp() { return { inserted: true }; }
  async saveFundamentals() { return true; }
  async saveValueAssessment() { return { inserted: true }; }
  async saveReverseDcf() { return { impliedFcfGrowth: "0.10" }; }
  async evaluateCashDeployment(input: Parameters<AppBridge["evaluateCashDeployment"]>[0]) { const failedChecks = [!input.red_line_clear && "red_line_clear", !input.evidence_complete && "evidence_complete", !input.valuation_current && "valuation_current", Number(input.expected_irr) < 15 && "expected_irr_at_least_15_percent", Number(input.bear_downside) > 25 && "bear_downside_at_most_25_percent", !input.balance_sheet_safe && "balance_sheet_safe", !input.liquidity_reserve_met && "liquidity_reserve_met", Number(input.resulting_single_name_weight) > 80 && "single_name_hard_cap_80_percent"].filter(Boolean) as string[]; return { canDeploy: failedChecks.length === 0, failedChecks, advisoryOnly: true as const }; }
  async saveStrategyDraft(_profileId: string, draft: Parameters<AppBridge["saveStrategyDraft"]>[1]) { if (draft.lifecycle !== "DRAFT") throw new Error("only draft strategies may enter through the draft boundary"); const existing = this.strategies.find((item) => item.strategy_id === draft.strategy_id && item.version === draft.version); if (existing) { if (JSON.stringify(existing) !== JSON.stringify(draft)) throw new Error("strategy version already exists with different content"); return false; } this.strategies.push(structuredClone(draft)); return true; }
  async validateStrategy(_profileId: string, strategyId: string, version: string) { const item = this.strategies.find((candidate) => candidate.strategy_id === strategyId && candidate.version === version); if (!item || item.lifecycle !== "DRAFT") throw new Error("strategy lifecycle transition is not allowed"); if (!strategyScenariosPass(item)) throw new Error("validated strategies require passing test scenarios"); item.lifecycle = "VALIDATED"; return structuredClone(item); }
  async publishStrategy(_profileId: string, strategyId: string, version: string) { const item = this.strategies.find((candidate) => candidate.strategy_id === strategyId && candidate.version === version); if (!item || item.lifecycle !== "VALIDATED") throw new Error("strategy lifecycle transition is not allowed"); this.strategies.filter((candidate) => candidate.strategy_id === strategyId && candidate.lifecycle === "PUBLISHED").forEach((candidate) => { candidate.lifecycle = "SUPERSEDED"; }); item.lifecycle = "PUBLISHED"; return structuredClone(item); }
  async listStrategies() { return structuredClone(this.strategies); }
  async recordDecisionExecution(input: Parameters<AppBridge["recordDecisionExecution"]>[0]) { return { applied: true, ledger: { quantity: String(213600 - Number(input.quantity)), cash: "mock" }, recommendation: { status: Number(input.quantity) >= 10560 ? "filled" : "partially_filled", filled_quantity: input.quantity } }; }

  async getLlmConfiguration() {
    return { configured: false, baseUrl: "local://mock", model: "mock-research-model" };
  }

  async configureLlm() {
    throw new Error("浏览器示例模式不会保存或使用BYOK密钥");
  }
  async getMarketProviderConfiguration() { return { configured: false, quoteUrl: "", sourceLabel: "", apiKeyStored: false }; }
  async configureMarketProvider() { throw new Error("浏览器示例模式不会保存或使用行情密钥"); }
  async refreshMarketQuote(): ReturnType<AppBridge["refreshMarketQuote"]> { throw new Error("浏览器示例模式不访问在线行情；请使用人工行情兜底"); }
  async getMcpConfiguration() { return { configured: false }; }
  async createMcpToken(): Promise<{ token: string }> { throw new Error("浏览器示例模式不会创建MCP令牌"); }
  async getLegacyMigration() { return { available: false, profiles: [] }; }
  async migrateLegacyProfiles(): Promise<{ imported: Array<{ id: string; name: string }> }> { throw new Error("浏览器示例模式没有旧桌面档案"); }
  async listDiagnostics(filter: Parameters<AppBridge["listDiagnostics"]>[0] = {}) {
    const events = this.diagnostics.filter((event) => (!filter.levels?.length || filter.levels.includes(event.level)) && (!filter.components?.length || filter.components.includes(event.component)) && (!filter.query || JSON.stringify(event).toLowerCase().includes(filter.query.toLowerCase())));
    return { events, nextCursor: null, total: events.length, components: ["akshare", "gateway"], summary: { status: "ok", version: "0.1.0-mock", uptimeSeconds: 125, lastError: null } };
  }
  async reportClientDiagnostic(event: Parameters<AppBridge["reportClientDiagnostic"]>[0]) { this.diagnostics.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), result: "reported", component: "browser", correlationId: event.correlationId ?? "browser", durationMs: null, source: null, fallbackUsed: false, ...event }); }
  async exportDiagnosticBundle() { return new Blob([JSON.stringify(this.diagnostics)], { type: "application/zip" }); }

  async previewAgentMessage(input: Parameters<AppBridge["previewAgentMessage"]>[0]) {
    return {
      destination: input.context.baseUrl,
      model: "mock-research-model",
      profileId: input.context.profileId,
      instrumentId: input.context.instrumentId,
      fields: input.context.fields,
      excluded: ["API密钥", "备份口令", "其他投资档案", "完整交易权限"],
      serializedBytes: new TextEncoder().encode(JSON.stringify(input)).length,
    };
  }

  async sendAgentMessage(input: Parameters<AppBridge["sendAgentMessage"]>[0]) {
    const requestsDraft = /策略|草稿|strategy/i.test(input.message);
    return {
      message: {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: requestsDraft
          ? "我已基于当前小米档案生成一份只读策略草稿。它不会影响正式策略，需要在差异审阅页人工发布。"
          : "当前仅附加了小米的持仓、阶段进度与研究状态。Stage 1 已完成，系统不会再次建议第一阶段卖出。",
      },
      artifact: requestsDraft
        ? {
            id: crypto.randomUUID(),
            kind: "strategy-draft" as const,
            title: "小米 Stage 2 反弹减仓检查表",
            status: "draft" as const,
            summary: "基本面未恶化、反弹成立、估值有效后，补足累计目标差额。",
          }
        : undefined,
      usage: { inputTokens: 328, outputTokens: 94 },
    };
  }
}

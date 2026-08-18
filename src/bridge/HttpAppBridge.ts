import type { AppBridge } from "./AppBridge";

let sessionPromise: Promise<void> | undefined;

async function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const existing = await fetch("/api/v1/session", { credentials: "include" });
      if (existing.ok) return;
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (!token) throw new Error("缺少本地 Gateway 启动令牌，请重新运行 npm run gateway:dev 或 npm run gateway:run");
      const response = await fetch("/api/v1/session", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Gateway 会话建立失败");
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    })();
  }
  return sessionPromise;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureSession();
  const response = await fetch(`/api/v1/invoke/${encodeURIComponent(command)}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const payload = await response.json() as { ok: boolean; value?: T; error?: string; correlationId?: string };
  if (!response.ok || !payload.ok) {
    const suffix = payload.correlationId ? ` [关联 ID: ${payload.correlationId}]` : "";
    throw new Error(`${payload.error ?? `Gateway 调用失败：${command}`}${suffix}`);
  }
  return payload.value as T;
}

export class HttpAppBridge implements AppBridge {
  readonly mode = "http" as const;

  listWatchlist(profileId: string) { return invoke<Awaited<ReturnType<AppBridge["listWatchlist"]>>>("list_watchlist", { profileId }); }
  saveInstrument(profileId: string, instrument: Parameters<AppBridge["saveInstrument"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["saveInstrument"]>>>("save_instrument", { input: { profileId, instrument } }); }
  removeWatchlistInstrument(profileId: string, instrumentId: string) { return invoke<Awaited<ReturnType<AppBridge["removeWatchlistInstrument"]>>>("remove_watchlist_instrument", { input: { profileId, instrumentId } }); }
  refreshWatchlistPrices(profileId: string) { return invoke<Awaited<ReturnType<AppBridge["refreshWatchlistPrices"]>>>("refresh_watchlist_prices", { profileId }); }
  getInstrumentSummary(profileId: string, instrumentId: string) { return invoke<Awaited<ReturnType<AppBridge["getInstrumentSummary"]>>>("get_instrument_summary", { input: { profileId, instrumentId } }); }
  listAnnualFinancials(profileId: string, instrumentId: string) { return invoke<Awaited<ReturnType<AppBridge["listAnnualFinancials"]>>>("list_annual_financials", { input: { profileId, instrumentId } }); }
  saveAnnualFinancials(profileId: string, financials: Parameters<AppBridge["saveAnnualFinancials"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["saveAnnualFinancials"]>>>("save_annual_financials", { input: { profileId, financials } }); }
  previewDcf(profileId: string, input: Parameters<AppBridge["previewDcf"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["previewDcf"]>>>("preview_dcf", { input: { profileId, input } }); }
  saveDcf(profileId: string, input: Parameters<AppBridge["saveDcf"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["saveDcf"]>>>("save_dcf_model", { input: { profileId, input } }); }
  refreshRelativeData(profileId: string, instrumentId: string) { return invoke<Awaited<ReturnType<AppBridge["refreshRelativeData"]>>>("refresh_relative_data", { input: { profileId, instrumentId } }); }
  previewRelativeValuation(profileId: string, input: Parameters<AppBridge["previewRelativeValuation"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["previewRelativeValuation"]>>>("preview_relative_valuation", { input: { profileId, input } }); }
  saveRelativeValuation(profileId: string, input: Parameters<AppBridge["saveRelativeValuation"]>[1]) { return invoke<Awaited<ReturnType<AppBridge["saveRelativeValuation"]>>>("save_relative_valuation", { input: { profileId, input } }); }

  getOverview(profileId?: string) {
    return invoke<Awaited<ReturnType<AppBridge["getOverview"]>>>("get_overview", { profileId });
  }

  getProfileActivity(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["getProfileActivity"]>>>("get_profile_activity", { profileId });
  }
  initializeLedgerBaseline(profileId: string, quantity: string, cash: string) {
    return invoke<Awaited<ReturnType<AppBridge["initializeLedgerBaseline"]>>>("initialize_ledger_baseline", { input: { profileId, quantity, cash } });
  }
  recordManualExecution(input: Parameters<AppBridge["recordManualExecution"]>[0]) {
    return invoke<Awaited<ReturnType<AppBridge["recordManualExecution"]>>>("record_manual_execution", { input });
  }
  reviseExecutionFees(profileId: string, executionKey: string, fees: Parameters<AppBridge["reviseExecutionFees"]>[2]) {
    return invoke<Awaited<ReturnType<AppBridge["reviseExecutionFees"]>>>("revise_execution_fees", { input: { profileId, executionKey, ...fees } });
  }

  listProfiles() {
    return invoke<Awaited<ReturnType<AppBridge["listProfiles"]>>>("list_profiles");
  }

  createProfile(name: string) {
    return invoke<{ id: string; name: string }>("create_profile", { name });
  }

  async exportProfileBackup(profileId: string, password: string) {
    const result = await invoke<{ data: string }>("export_profile_backup_bytes", { profileId, password });
    const normalized = result.data.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: "application/octet-stream" });
  }

  importProfileBackup(password: string, source: ArrayBuffer) {
    const bytes = new Uint8Array(source);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const data = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return invoke<{ id: string; name: string }>("import_profile_backup_bytes", { password, data });
  }

  evaluateXiaomiDecision(profileId: string, signals: Parameters<AppBridge["evaluateXiaomiDecision"]>[1]) {
    return invoke<Awaited<ReturnType<AppBridge["evaluateXiaomiDecision"]>>>("evaluate_xiaomi_decision", { input: { profileId, signals } });
  }

  acceptDecision(profileId: string, decisionKey: string) {
    return invoke("accept_decision", { profileId, decisionKey });
  }

  rejectDecision(profileId: string, decisionKey: string, reason: string) {
    return invoke("reject_decision", { profileId, decisionKey, reason });
  }

  replayDecision(profileId: string, decisionKey: string) {
    return invoke<boolean>("replay_decision", { profileId, decisionKey });
  }

  saveManualQuote(profileId: string, price: string, observedAt: string, sourceLabel: string) {
    return invoke<boolean>("save_manual_quote", { input: { profileId, price, observedAt, sourceLabel } });
  }

  saveSotp(profileId: string, snapshot: Parameters<AppBridge["saveSotp"]>[1]) {
    return invoke("save_sotp", { profileId, snapshot });
  }

  saveFundamentals(profileId: string, snapshot: Parameters<AppBridge["saveFundamentals"]>[1]) {
    return invoke<boolean>("save_fundamentals", { profileId, snapshot });
  }

  saveValueAssessment(profileId: string, assessment: Parameters<AppBridge["saveValueAssessment"]>[1]) {
    return invoke("save_value_assessment", { profileId, assessment });
  }

  saveReverseDcf(profileId: string, snapshot: Parameters<AppBridge["saveReverseDcf"]>[1]) {
    return invoke<Awaited<ReturnType<AppBridge["saveReverseDcf"]>>>("save_reverse_dcf", { profileId, snapshot });
  }
  evaluateCashDeployment(guard: Parameters<AppBridge["evaluateCashDeployment"]>[0]) {
    return invoke<Awaited<ReturnType<AppBridge["evaluateCashDeployment"]>>>("evaluate_cash_deployment", { guard });
  }

  saveStrategyDraft(profileId: string, draft: Parameters<AppBridge["saveStrategyDraft"]>[1]) {
    return invoke<boolean>("save_strategy_draft", { profileId, draft });
  }
  validateStrategy(profileId: string, strategyId: string, version: string) {
    return invoke<Awaited<ReturnType<AppBridge["validateStrategy"]>>>("validate_strategy", { profileId, strategyId, version });
  }
  publishStrategy(profileId: string, strategyId: string, version: string) {
    return invoke<Awaited<ReturnType<AppBridge["publishStrategy"]>>>("publish_strategy", { profileId, strategyId, version });
  }
  listStrategies(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["listStrategies"]>>>("list_strategies", { profileId });
  }

  recordDecisionExecution(input: Parameters<AppBridge["recordDecisionExecution"]>[0]) {
    return invoke<Awaited<ReturnType<AppBridge["recordDecisionExecution"]>>>("record_decision_execution", { input });
  }

  getLlmConfiguration(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["getLlmConfiguration"]>>>("get_llm_configuration", { profileId });
  }

  configureLlm(input: Parameters<AppBridge["configureLlm"]>[0]) {
    return invoke<void>("configure_llm", {
      config: {
        base_url: input.baseUrl,
        model: input.model,
        capabilities: { responses_api: true, structured_outputs: false, streaming: false, tools_enabled: false },
      },
      profileId: input.profileId,
      apiKey: input.apiKey,
    });
  }

  getMarketProviderConfiguration(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["getMarketProviderConfiguration"]>>>("get_market_provider_configuration", { profileId });
  }
  configureMarketProvider(profileId: string, quoteUrl: string, sourceLabel: string, apiKey: string) {
    return invoke<void>("configure_market_provider", { profileId, config: { quote_url: quoteUrl, source_label: sourceLabel }, apiKey });
  }
  refreshMarketQuote(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["refreshMarketQuote"]>>>("refresh_market_quote", { profileId });
  }

  previewAgentMessage(input: Parameters<AppBridge["previewAgentMessage"]>[0]) {
    return invoke<Awaited<ReturnType<AppBridge["previewAgentMessage"]>>>("preview_agent_message", { input });
  }

  sendAgentMessage(input: Parameters<AppBridge["sendAgentMessage"]>[0]) {
    return invoke<Awaited<ReturnType<AppBridge["sendAgentMessage"]>>>("send_agent_message", { input });
  }

  getMcpConfiguration(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["getMcpConfiguration"]>>>("get_mcp_configuration", { profileId });
  }

  createMcpToken(profileId: string) {
    return invoke<Awaited<ReturnType<AppBridge["createMcpToken"]>>>("create_mcp_token", { profileId });
  }

  getLegacyMigration() {
    return invoke<Awaited<ReturnType<AppBridge["getLegacyMigration"]>>>("get_legacy_migration");
  }

  migrateLegacyProfiles() {
    return invoke<Awaited<ReturnType<AppBridge["migrateLegacyProfiles"]>>>("migrate_legacy_profiles");
  }

  listDiagnostics(filter: Parameters<AppBridge["listDiagnostics"]>[0] = {}) {
    return invoke<Awaited<ReturnType<AppBridge["listDiagnostics"]>>>("list_diagnostics", { filter });
  }

  async reportClientDiagnostic(event: Parameters<AppBridge["reportClientDiagnostic"]>[0]) {
    await invoke("report_client_diagnostic", { event });
  }

  async exportDiagnosticBundle() {
    const result = await invoke<{ data: string }>("export_diagnostic_bundle");
    const normalized = result.data.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: "application/zip" });
  }
}

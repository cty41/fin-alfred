import { invoke } from "@tauri-apps/api/core";
import type { AppBridge } from "./AppBridge";

export class TauriAppBridge implements AppBridge {
  readonly mode = "desktop" as const;

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

  exportProfileBackup(profileId: string, password: string, destination: string) {
    return invoke<void>("export_profile_backup", { profileId, password, destination });
  }

  importProfileBackup(password: string, source: string) {
    return invoke<{ id: string; name: string }>("import_profile_backup", { password, source });
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
}

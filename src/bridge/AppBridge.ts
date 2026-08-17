import type { AgentMessage, AgentReply, AgentTransmissionPreview, CashDeploymentInput, ContextManifest, DecisionEvaluation, DecisionExecutionInput, FundamentalInput, LlmConfigurationInput, LlmConfigurationStatus, ManualExecutionInput, MarketProviderConfiguration, ProfileActivity, ProfileOverview, ReverseDcfInput, SotpInput, StrategyDraftInput, ValueAssessmentInput, XiaomiSignals } from "../domain/types";

export interface AgentMessageInput {
  conversationId: string;
  message: string;
  history: AgentMessage[];
  context: ContextManifest;
}

export interface AppBridge {
  readonly mode: "mock" | "memory" | "http";
  getOverview(profileId?: string): Promise<ProfileOverview>;
  listProfiles(): Promise<Array<{ id: string; name: string }>>;
  createProfile(name: string): Promise<{ id: string; name: string }>;
  exportProfileBackup(profileId: string, password: string): Promise<Blob>;
  importProfileBackup(password: string, source: ArrayBuffer): Promise<{ id: string; name: string }>;
  evaluateXiaomiDecision(profileId: string, signals: XiaomiSignals): Promise<DecisionEvaluation>;
  acceptDecision(profileId: string, decisionKey: string): Promise<unknown>;
  rejectDecision(profileId: string, decisionKey: string, reason: string): Promise<unknown>;
  replayDecision(profileId: string, decisionKey: string): Promise<boolean>;
  saveManualQuote(profileId: string, price: string, observedAt: string, sourceLabel: string): Promise<boolean>;
  saveSotp(profileId: string, snapshot: SotpInput): Promise<unknown>;
  saveFundamentals(profileId: string, snapshot: FundamentalInput): Promise<boolean>;
  saveValueAssessment(profileId: string, assessment: ValueAssessmentInput): Promise<unknown>;
  saveReverseDcf(profileId: string, snapshot: ReverseDcfInput): Promise<{ impliedFcfGrowth: string }>;
  evaluateCashDeployment(input: CashDeploymentInput): Promise<{ canDeploy: boolean; failedChecks: string[]; advisoryOnly: true }>;
  saveStrategyDraft(profileId: string, draft: StrategyDraftInput): Promise<boolean>;
  validateStrategy(profileId: string, strategyId: string, version: string): Promise<StrategyDraftInput>;
  publishStrategy(profileId: string, strategyId: string, version: string): Promise<StrategyDraftInput>;
  listStrategies(profileId: string): Promise<StrategyDraftInput[]>;
  recordDecisionExecution(input: DecisionExecutionInput): Promise<{ applied: boolean; ledger: { quantity: string; cash: string }; recommendation: { status: string; filled_quantity: string } }>;
  getProfileActivity(profileId: string): Promise<ProfileActivity>;
  initializeLedgerBaseline(profileId: string, quantity: string, cash: string): Promise<ProfileActivity["ledger"]>;
  recordManualExecution(input: ManualExecutionInput): Promise<{ applied: boolean; ledger: ProfileActivity["ledger"]; executionKey: string }>;
  reviseExecutionFees(profileId: string, executionKey: string, fees: { stampDuty: string; clearingFee: string; transferFee: string; commission: string }): Promise<{ applied: boolean; cash: string; quantity: string }>;
  previewAgentMessage(input: AgentMessageInput): Promise<AgentTransmissionPreview>;
  sendAgentMessage(input: AgentMessageInput): Promise<AgentReply>;
  getLlmConfiguration(profileId: string): Promise<LlmConfigurationStatus>;
  configureLlm(input: LlmConfigurationInput): Promise<void>;
  getMarketProviderConfiguration(profileId: string): Promise<MarketProviderConfiguration>;
  configureMarketProvider(profileId: string, quoteUrl: string, sourceLabel: string, apiKey: string): Promise<void>;
  refreshMarketQuote(profileId: string): Promise<{ inserted: boolean; snapshot: { price: string; observed_at: string; source_label: string } }>;
  getMcpConfiguration(profileId: string): Promise<{ configured: boolean }>;
  createMcpToken(profileId: string): Promise<{ token: string }>;
  getLegacyMigration(): Promise<{ available: boolean; directory?: string; profiles: Array<{ sourceId: string; name: string; quantity: string; cash: string; migrated: boolean }> }>;
  migrateLegacyProfiles(): Promise<{ imported: Array<{ id: string; name: string }> }>;
}

export type Currency = "HKD";
export type ResearchStatus = "fresh" | "review" | "blocked";
export type StrategyStageStatus = "completed" | "waiting" | "blocked";

export interface Money {
  amount: string;
  currency: Currency;
}

export interface FeeBreakdown {
  stampDuty: Money;
  clearingFee: Money;
  transferFee: Money;
  commission: Money;
  total: Money;
}

export interface Transaction {
  id: string;
  executionKey: string;
  instrumentId: string;
  side: "sell" | "buy";
  tradedAt: string;
  quantity: string;
  price: Money;
  grossAmount: Money;
  fees: FeeBreakdown;
  netCashFlow: Money;
}

export interface QualityDimension {
  id: string;
  label: string;
  score: 0 | 1 | 2 | 3 | 4 | null;
  trend: "up" | "flat" | "down" | "unknown";
  evidenceFreshness: "fresh" | "aging" | "missing";
}

export interface ValuationSummary {
  bear: Money;
  base: Money;
  bull: Money;
  baseIrr: string;
  reverseDcf: string;
  confidence: "high" | "medium" | "low";
  validThrough: string;
}

export interface StrategyStage {
  stage: 1 | 2 | 3 | 4;
  label: string;
  cumulativeTargetQuantity: string;
  actualCumulativeQuantity: string;
  status: StrategyStageStatus;
  nextRequirement: string;
}

export interface ProfileOverview {
  profileId: string;
  profileName: string;
  instrumentId: string;
  symbol: string;
  instrumentName: string;
  initialQuantity: string;
  currentQuantity: string;
  cash: Money;
  cashVerification: "verified" | "inferred";
  transaction?: Transaction;
  valuation: ValuationSummary;
  researchStatus: ResearchStatus;
  unknownCount: number;
  liLu: QualityDimension[];
  burry: QualityDimension[];
  stages: StrategyStage[];
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface AgentArtifact {
  id: string;
  kind: "strategy-draft" | "research-draft" | "checklist-draft";
  title: string;
  status: "draft" | "validated" | "invalid";
  summary: string;
}

export interface AgentReply {
  message: AgentMessage;
  artifact?: AgentArtifact;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ContextManifest {
  profileId: string;
  instrumentId?: string;
  fields: string[];
  provider: string;
  baseUrl: string;
}

export interface AgentTransmissionPreview {
  destination: string;
  model: string;
  profileId: string;
  instrumentId?: string;
  fields: string[];
  excluded: string[];
  serializedBytes: number;
}

export interface LlmConfigurationInput {
  profileId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmConfigurationStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}

export interface MarketProviderConfiguration {
  configured: boolean;
  quoteUrl: string;
  sourceLabel: string;
  apiKeyStored: boolean;
}

export interface XiaomiSignals {
  thesis_invalidated: boolean;
  fundamentals_deteriorated: boolean;
  fundamentals_strong: boolean;
  market_crash: boolean;
  rebound_confirmed_by_user: boolean;
  valuation_current: boolean;
  valuation_less_attractive: boolean;
  earnings_confirmed: boolean;
  ev_orders_confirmed: boolean;
  ev_deliveries_confirmed: boolean;
  gross_margin_confirmed: boolean;
  new_model_data_confirmed: boolean;
  macro_checklist_confirmed: boolean;
  sotp_confirmed: boolean;
  irr_confirmed: boolean;
  concentration_confirmed: boolean;
}

export interface DecisionEvaluation {
  outcome: { outcome: "wait" | "propose_sell" | "exit_review" | "completed"; reason_code?: string; missing_checks?: string[]; stage?: number; quantity?: string };
  recommendation?: { decision_key: string; status: string; target_quantity: string; filled_quantity: string } | null;
}

export interface SotpInput {
  profile_id: string;
  instrument_id: string;
  as_of: string;
  review_due: string;
  components: Array<{ name: string; bear_value: string; base_value: string; bull_value: string; confidence: "low" | "medium" | "high"; evidence_reference: string }>;
  group_adjustment: { name: string; bear_value: string; base_value: string; bull_value: string; confidence: "low" | "medium" | "high"; evidence_reference: string };
  diluted_shares: string;
}

export interface FundamentalInput {
  profile_id: string; instrument_id: string; period_end: string; published_at: string;
  valid_until: string; source_label: string; metrics: Record<string, string | null>;
}

export type EvidenceScoreInput = "unknown" | "zero" | "one" | "two" | "three" | "four";
export interface ValueAssessmentInput {
  gate: "clear" | "yellow" | "red";
  li_lu: { moat: EvidenceScoreInput; incremental_roic: EvidenceScoreInput; cash_conversion: EvidenceScoreInput; management_and_allocation: EvidenceScoreInput; balance_sheet: EvidenceScoreInput; runway: EvidenceScoreInput };
  burry: { valuation_discount: EvidenceScoreInput; bear_protection: EvidenceScoreInput; balance_sheet: EvidenceScoreInput; normalized_fcf: EvidenceScoreInput; expectation_gap: EvidenceScoreInput; catalyst: EvidenceScoreInput };
}
export interface ReverseDcfInput {
  profile_id: string; instrument_id: string; as_of: string; review_due: string;
  enterprise_value: string; starting_free_cash_flow: string; discount_rate: string;
  terminal_multiple: string; years: number; evidence_reference: string;
}
export interface CashDeploymentInput {
  red_line_clear: boolean; evidence_complete: boolean; valuation_current: boolean;
  expected_irr: string; bear_downside: string; balance_sheet_safe: boolean;
  liquidity_reserve_met: boolean; resulting_single_name_weight: string;
}

export interface DecisionExecutionInput {
  profileId: string; decisionKey: string; tradedAt: string; quantity: string; price: string;
  stampDuty: string; clearingFee: string; transferFee: string; commission: string; externalId?: string;
}
export interface ManualExecutionInput {
  profileId: string; side: "buy" | "sell"; tradedAt: string; quantity: string; price: string;
  stampDuty: string; clearingFee: string; transferFee: string; commission: string; externalId?: string;
}

export type StrategyComparison = "less_than" | "less_or_equal" | "greater_than" | "greater_or_equal" | "equal";
export interface StrategyMetricReference {
  name: string;
  value_type: "decimal" | "percentage" | "integer";
  unit?: string;
}
export type StrategyCondition =
  | { kind: "metric_comparison"; metric: string; operator: StrategyComparison; value: number }
  | { kind: "all" | "any"; conditions: StrategyCondition[] }
  | { kind: "human_confirmation"; checklist_id: string }
  | { kind: "typed_metric_comparison"; metric: StrategyMetricReference; operator: StrategyComparison; value: number }
  | { kind: "time_comparison"; field: string; operator: "before" | "on_or_before" | "after" | "on_or_after" | "equal"; value: string }
  | { kind: "band"; metric: StrategyMetricReference; minimum?: number; maximum?: number }
  | { kind: "portfolio_constraint"; metric: StrategyMetricReference; operator: StrategyComparison; value: number }
  | { kind: "manual_checklist"; checklist_id: string; items: string[] }
  | { kind: "state_machine"; machine_id: string; states: string[]; transitions: Array<{ from: string; to: string; when: StrategyCondition }> };

export interface StrategyDraftInput {
  schema_version: number;
  strategy_id: string;
  version: string;
  condition: StrategyCondition;
  suggestion: { action: string; reason_code: string; invalidation: string };
  lifecycle: "DRAFT" | "VALIDATED" | "PUBLISHED" | "SUPERSEDED";
  test_scenarios: Array<{ name: string; inputs: Record<string, unknown>; expected_match: boolean; expected_action?: string }>;
}

export interface ProfileActivity {
  ledger: { profileId: string; instrumentId: string; quantity: string; cash: string; currency: string };
  executions: Array<{ executionKey: string; profileId: string; instrumentId: string; side: string; tradedAt: string; quantity: string; price: string; grossAmount: string; netCashFlow: string; stampDuty: string; clearingFee: string; transferFee: string; commission: string; externalId?: string; createdAt: string }>;
  decisions: Array<{ decision_key: string; status: string; target_quantity: string; filled_quantity: string; snapshot: { strategy_version: string; engine_version: string; facts: Record<string, string> }; resolution_reason?: string; superseded_by?: string }>;
  audits: Array<{ id: number; profileId: string; aggregateType: string; aggregateId: string; eventType: string; payload: unknown; createdAt: string }>;
}

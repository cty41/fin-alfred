use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransitionStage {
    pub stage: u8,
    pub cumulative_target: Decimal,
    pub status: StageStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageStatus {
    Completed,
    Waiting,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedPositionTransition {
    pub baseline_quantity: Decimal,
    pub actual_cumulative_sold: Decimal,
    pub stages: Vec<TransitionStage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct XiaomiSignals {
    pub thesis_invalidated: bool,
    pub fundamentals_deteriorated: bool,
    pub fundamentals_strong: bool,
    pub market_crash: bool,
    pub rebound_confirmed_by_user: bool,
    pub valuation_current: bool,
    pub valuation_less_attractive: bool,
    pub earnings_confirmed: bool,
    pub ev_orders_confirmed: bool,
    pub ev_deliveries_confirmed: bool,
    pub gross_margin_confirmed: bool,
    pub new_model_data_confirmed: bool,
    pub macro_checklist_confirmed: bool,
    pub sotp_confirmed: bool,
    pub irr_confirmed: bool,
    pub concentration_confirmed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum StrategyOutcome {
    Wait {
        reason_code: String,
        missing_checks: Vec<String>,
    },
    ProposeSell {
        stage: u8,
        quantity: Decimal,
        reason_code: String,
    },
    ExitReview {
        reason_code: String,
    },
    Completed,
}

impl StagedPositionTransition {
    pub fn xiaomi(initial: Decimal, sold: Decimal) -> Self {
        let five_percent = initial * Decimal::new(5, 2);
        let stages = (1..=4)
            .map(|stage| {
                let target = five_percent * Decimal::from(stage);
                let status = if sold >= target {
                    StageStatus::Completed
                } else if stage == 2 {
                    StageStatus::Waiting
                } else {
                    StageStatus::Blocked
                };
                TransitionStage {
                    stage,
                    cumulative_target: target,
                    status,
                }
            })
            .collect();
        Self {
            baseline_quantity: initial,
            actual_cumulative_sold: sold,
            stages,
        }
    }

    pub fn remaining_to_stage(&self, stage: u8) -> Option<Decimal> {
        self.stages
            .iter()
            .find(|item| item.stage == stage)
            .map(|item| (item.cumulative_target - self.actual_cumulative_sold).max(Decimal::ZERO))
    }

    pub fn evaluate(&self, signals: &XiaomiSignals) -> StrategyOutcome {
        if signals.thesis_invalidated {
            return StrategyOutcome::ExitReview {
                reason_code: "THESIS_INVALIDATED_REVIEW_REQUIRED".into(),
            };
        }
        if signals.fundamentals_strong && signals.market_crash {
            return StrategyOutcome::Wait {
                reason_code: "MARKET_CRASH_NO_MECHANICAL_SELL".into(),
                missing_checks: vec![],
            };
        }
        let next = self
            .stages
            .iter()
            .find(|stage| stage.status != StageStatus::Completed);
        let Some(next) = next else {
            return StrategyOutcome::Completed;
        };
        let quantity = self.remaining_to_stage(next.stage).unwrap_or(Decimal::ZERO);
        match next.stage {
            1 => StrategyOutcome::Wait {
                reason_code: "STAGE_1_INSURANCE_NOT_EXECUTED".into(),
                missing_checks: vec!["manual_acceptance".into()],
            },
            2 => {
                let mut missing = Vec::new();
                if signals.fundamentals_deteriorated {
                    missing.push("fundamentals_not_deteriorated".into());
                }
                if !signals.rebound_confirmed_by_user {
                    missing.push("user_confirmed_rebound".into());
                }
                if !signals.valuation_current {
                    missing.push("current_valuation_and_quote".into());
                }
                if missing.is_empty() {
                    StrategyOutcome::ProposeSell {
                        stage: 2,
                        quantity,
                        reason_code: "STAGE_2_REBOUND_GAP".into(),
                    }
                } else {
                    StrategyOutcome::Wait {
                        reason_code: "STAGE_2_CHECKLIST_INCOMPLETE".into(),
                        missing_checks: missing,
                    }
                }
            }
            3 => {
                let checks = [
                    (signals.earnings_confirmed, "earnings"),
                    (signals.ev_orders_confirmed, "ev_orders"),
                    (signals.ev_deliveries_confirmed, "ev_deliveries"),
                    (signals.gross_margin_confirmed, "gross_margin"),
                    (signals.new_model_data_confirmed, "new_model_data"),
                    (
                        signals.valuation_less_attractive,
                        "valuation_less_attractive",
                    ),
                ];
                let missing: Vec<String> = checks
                    .into_iter()
                    .filter(|(ok, _)| !ok)
                    .map(|(_, name)| name.into())
                    .collect();
                if missing.is_empty() {
                    StrategyOutcome::ProposeSell {
                        stage: 3,
                        quantity,
                        reason_code: "STAGE_3_POST_RESULTS_VALUATION".into(),
                    }
                } else {
                    StrategyOutcome::Wait {
                        reason_code: "STAGE_3_CHECKLIST_INCOMPLETE".into(),
                        missing_checks: missing,
                    }
                }
            }
            4 => {
                let checks = [
                    (signals.macro_checklist_confirmed, "macro_and_market_regime"),
                    (signals.sotp_confirmed, "sotp"),
                    (signals.irr_confirmed, "irr"),
                    (signals.concentration_confirmed, "concentration"),
                ];
                let missing: Vec<String> = checks
                    .into_iter()
                    .filter(|(ok, _)| !ok)
                    .map(|(_, name)| name.into())
                    .collect();
                if missing.is_empty() {
                    StrategyOutcome::ProposeSell {
                        stage: 4,
                        quantity,
                        reason_code: "STAGE_4_COMPREHENSIVE_RISK".into(),
                    }
                } else {
                    StrategyOutcome::Wait {
                        reason_code: "STAGE_4_CHECKLIST_INCOMPLETE".into(),
                        missing_checks: missing,
                    }
                }
            }
            _ => StrategyOutcome::Completed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_first_sale_completes_stage_one_without_reopening_it() {
        let plan = StagedPositionTransition::xiaomi(Decimal::from(225_600), Decimal::from(12_000));
        assert_eq!(plan.stages[0].cumulative_target, Decimal::from(11_280));
        assert_eq!(plan.stages[0].status, StageStatus::Completed);
        assert_eq!(plan.remaining_to_stage(1), Some(Decimal::ZERO));
        assert_eq!(plan.remaining_to_stage(2), Some(Decimal::from(10_560)));
    }

    #[test]
    fn stage_one_never_reappears_and_stage_two_uses_only_the_cumulative_gap() {
        let plan = StagedPositionTransition::xiaomi(Decimal::from(225_600), Decimal::from(12_000));
        let outcome = plan.evaluate(&XiaomiSignals {
            rebound_confirmed_by_user: true,
            valuation_current: true,
            ..XiaomiSignals::default()
        });
        assert_eq!(
            outcome,
            StrategyOutcome::ProposeSell {
                stage: 2,
                quantity: Decimal::from(10_560),
                reason_code: "STAGE_2_REBOUND_GAP".into()
            }
        );
    }

    #[test]
    fn invalidation_opens_exit_review_and_market_crash_does_not_mechanically_sell() {
        let plan = StagedPositionTransition::xiaomi(Decimal::from(225_600), Decimal::from(12_000));
        assert!(matches!(
            plan.evaluate(&XiaomiSignals {
                thesis_invalidated: true,
                ..XiaomiSignals::default()
            }),
            StrategyOutcome::ExitReview { .. }
        ));
        assert_eq!(
            plan.evaluate(&XiaomiSignals {
                fundamentals_strong: true,
                market_crash: true,
                ..XiaomiSignals::default()
            }),
            StrategyOutcome::Wait {
                reason_code: "MARKET_CRASH_NO_MECHANICAL_SELL".into(),
                missing_checks: vec![]
            }
        );
    }
}

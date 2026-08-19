use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Condition {
    MetricComparison {
        metric: String,
        operator: Comparison,
        value: f64,
    },
    All {
        conditions: Vec<Condition>,
    },
    Any {
        conditions: Vec<Condition>,
    },
    HumanConfirmation {
        checklist_id: String,
    },
    TypedMetricComparison {
        metric: MetricReference,
        operator: Comparison,
        value: f64,
    },
    TimeComparison {
        field: String,
        operator: TimeComparison,
        value: NaiveDate,
    },
    Band {
        metric: MetricReference,
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    PortfolioConstraint {
        metric: MetricReference,
        operator: Comparison,
        value: f64,
    },
    ManualChecklist {
        checklist_id: String,
        items: Vec<String>,
    },
    StateMachine {
        machine_id: String,
        states: Vec<String>,
        transitions: Vec<StateTransition>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricReference {
    pub name: String,
    pub value_type: MetricValueType,
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricValueType {
    Decimal,
    Percentage,
    Integer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeComparison {
    Before,
    OnOrBefore,
    After,
    OnOrAfter,
    Equal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateTransition {
    pub from: String,
    pub to: String,
    pub when: Box<Condition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    LessThan,
    LessOrEqual,
    GreaterThan,
    GreaterOrEqual,
    Equal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedAction {
    pub action: String,
    pub reason_code: String,
    pub invalidation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyDraft {
    pub schema_version: u32,
    pub strategy_id: String,
    pub version: String,
    pub condition: Condition,
    pub suggestion: SuggestedAction,
    pub lifecycle: ResearchLifecycle,
    #[serde(default)]
    pub test_scenarios: Vec<StrategyTestScenario>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyTestScenario {
    pub name: String,
    pub inputs: BTreeMap<String, Value>,
    pub expected_match: bool,
    pub expected_action: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StrategyScenarioResult {
    pub name: String,
    pub expected_match: bool,
    pub actual_match: Option<bool>,
    pub expected_action: Option<String>,
    pub actual_action: Option<String>,
    pub passed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResearchLifecycle {
    Draft,
    Validated,
    Published,
    Superseded,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DslError {
    #[error("only draft strategies may enter through the draft boundary")]
    NotDraft,
    #[error("strategy identifiers and reason codes must be present")]
    MissingIdentity,
    #[error("condition tree is empty or exceeds the safe depth")]
    InvalidConditionTree,
    #[error("strategy lifecycle transition is not allowed")]
    InvalidLifecycleTransition,
    #[error("validated strategies require passing test scenarios")]
    MissingOrFailingScenarios,
}

impl StrategyDraft {
    pub fn validate_as_draft(&self) -> Result<(), DslError> {
        if self.lifecycle != ResearchLifecycle::Draft {
            return Err(DslError::NotDraft);
        }
        if self.strategy_id.trim().is_empty() || self.suggestion.reason_code.trim().is_empty() {
            return Err(DslError::MissingIdentity);
        }
        validate_condition(&self.condition, 0)
    }

    pub fn validate(mut self) -> Result<Self, DslError> {
        self.validate_as_draft()?;
        if self.test_scenarios.is_empty() || self.replay_test_scenarios().iter().any(|r| !r.passed)
        {
            return Err(DslError::MissingOrFailingScenarios);
        }
        self.lifecycle = ResearchLifecycle::Validated;
        Ok(self)
    }

    pub fn publish(mut self) -> Result<Self, DslError> {
        if self.lifecycle != ResearchLifecycle::Validated {
            return Err(DslError::InvalidLifecycleTransition);
        }
        self.lifecycle = ResearchLifecycle::Published;
        Ok(self)
    }

    pub fn replay_test_scenarios(&self) -> Vec<StrategyScenarioResult> {
        self.test_scenarios
            .iter()
            .map(|scenario| {
                let actual_match = evaluate_condition(&self.condition, &scenario.inputs, 0);
                let actual_action =
                    (actual_match == Some(true)).then(|| self.suggestion.action.clone());
                let passed = !scenario.name.trim().is_empty()
                    && actual_match == Some(scenario.expected_match)
                    && actual_action == scenario.expected_action;
                StrategyScenarioResult {
                    name: scenario.name.clone(),
                    expected_match: scenario.expected_match,
                    actual_match,
                    expected_action: scenario.expected_action.clone(),
                    actual_action,
                    passed,
                }
            })
            .collect()
    }
}

fn validate_condition(condition: &Condition, depth: usize) -> Result<(), DslError> {
    if depth > 16 {
        return Err(DslError::InvalidConditionTree);
    }
    match condition {
        Condition::All { conditions } | Condition::Any { conditions } => {
            if conditions.is_empty() {
                return Err(DslError::InvalidConditionTree);
            }
            for child in conditions {
                validate_condition(child, depth + 1)?;
            }
        }
        Condition::MetricComparison { metric, .. } if metric.trim().is_empty() => {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::HumanConfirmation { checklist_id } if checklist_id.trim().is_empty() => {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::TypedMetricComparison { metric, .. }
        | Condition::PortfolioConstraint { metric, .. }
        | Condition::Band { metric, .. }
            if metric.name.trim().is_empty() =>
        {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::Band {
            minimum, maximum, ..
        } if (minimum.is_none() && maximum.is_none())
            || matches!((minimum, maximum), (Some(low), Some(high)) if low > high) =>
        {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::TimeComparison { field, .. } if field.trim().is_empty() => {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::ManualChecklist {
            checklist_id,
            items,
        } if checklist_id.trim().is_empty()
            || items.is_empty()
            || items.iter().any(|item| item.trim().is_empty()) =>
        {
            return Err(DslError::InvalidConditionTree)
        }
        Condition::StateMachine {
            machine_id,
            states,
            transitions,
        } => {
            let unique: HashSet<&str> = states.iter().map(String::as_str).collect();
            if machine_id.trim().is_empty()
                || states.is_empty()
                || states.len() > 64
                || unique.len() != states.len()
                || transitions.is_empty()
            {
                return Err(DslError::InvalidConditionTree);
            }
            for transition in transitions {
                if !unique.contains(transition.from.as_str())
                    || !unique.contains(transition.to.as_str())
                {
                    return Err(DslError::InvalidConditionTree);
                }
                validate_condition(&transition.when, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn evaluate_condition(
    condition: &Condition,
    inputs: &BTreeMap<String, Value>,
    depth: usize,
) -> Option<bool> {
    if depth > 16 {
        return None;
    }
    match condition {
        Condition::MetricComparison {
            metric,
            operator,
            value,
        } => compare(inputs.get(metric)?.as_f64()?, *operator, *value),
        Condition::TypedMetricComparison {
            metric,
            operator,
            value,
        }
        | Condition::PortfolioConstraint {
            metric,
            operator,
            value,
        } => compare(metric_value(inputs, metric)?, *operator, *value),
        Condition::All { conditions } => conditions.iter().try_fold(true, |result, item| {
            Some(result && evaluate_condition(item, inputs, depth + 1)?)
        }),
        Condition::Any { conditions } => conditions.iter().try_fold(false, |result, item| {
            Some(result || evaluate_condition(item, inputs, depth + 1)?)
        }),
        Condition::HumanConfirmation { checklist_id } => inputs.get(checklist_id)?.as_bool(),
        Condition::TimeComparison {
            field,
            operator,
            value,
        } => {
            let actual =
                NaiveDate::parse_from_str(inputs.get(field)?.as_str()?, "%Y-%m-%d").ok()?;
            Some(match operator {
                TimeComparison::Before => actual < *value,
                TimeComparison::OnOrBefore => actual <= *value,
                TimeComparison::After => actual > *value,
                TimeComparison::OnOrAfter => actual >= *value,
                TimeComparison::Equal => actual == *value,
            })
        }
        Condition::Band {
            metric,
            minimum,
            maximum,
        } => {
            let actual = metric_value(inputs, metric)?;
            Some(
                minimum.is_none_or(|low| actual >= low)
                    && maximum.is_none_or(|high| actual <= high),
            )
        }
        Condition::ManualChecklist {
            checklist_id,
            items,
        } => Some(items.iter().all(|item| {
            inputs
                .get(&format!("{checklist_id}.{item}"))
                .and_then(Value::as_bool)
                == Some(true)
        })),
        Condition::StateMachine {
            machine_id,
            transitions,
            ..
        } => {
            let current = inputs.get(machine_id)?.as_str()?;
            Some(
                transitions
                    .iter()
                    .filter(|item| item.from == current)
                    .any(|item| evaluate_condition(&item.when, inputs, depth + 1) == Some(true)),
            )
        }
    }
}

fn metric_value(inputs: &BTreeMap<String, Value>, metric: &MetricReference) -> Option<f64> {
    let value = inputs.get(&metric.name)?.as_f64()?;
    match metric.value_type {
        MetricValueType::Integer if value.fract() != 0.0 => None,
        MetricValueType::Percentage if !(0.0..=100.0).contains(&value) => None,
        _ => Some(value),
    }
}

fn compare(actual: f64, operator: Comparison, expected: f64) -> Option<bool> {
    if !actual.is_finite() || !expected.is_finite() {
        return None;
    }
    Some(match operator {
        Comparison::LessThan => actual < expected,
        Comparison::LessOrEqual => actual <= expected,
        Comparison::GreaterThan => actual > expected,
        Comparison::GreaterOrEqual => actual >= expected,
        Comparison::Equal => (actual - expected).abs() < f64::EPSILON,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_cannot_smuggle_a_published_strategy_through_draft_validation() {
        let strategy = StrategyDraft {
            schema_version: 1,
            strategy_id: "xiaomi-stage-2".into(),
            version: "1".into(),
            condition: Condition::HumanConfirmation {
                checklist_id: "rebound-confirmation".into(),
            },
            suggestion: SuggestedAction {
                action: "review_sell_gap".into(),
                reason_code: "STAGE_2_REBOUND".into(),
                invalidation: "fundamental_thesis_invalidated".into(),
            },
            lifecycle: ResearchLifecycle::Published,
            test_scenarios: vec![],
        };
        assert_eq!(strategy.validate_as_draft(), Err(DslError::NotDraft));
    }

    #[test]
    fn formal_strategy_requires_validation_before_publication() {
        let draft = StrategyDraft {
            schema_version: 1,
            strategy_id: "xiaomi-stage-2".into(),
            version: "2".into(),
            condition: Condition::HumanConfirmation {
                checklist_id: "rebound-confirmation".into(),
            },
            suggestion: SuggestedAction {
                action: "review_sell_gap".into(),
                reason_code: "STAGE_2_REBOUND".into(),
                invalidation: "fundamental_thesis_invalidated".into(),
            },
            lifecycle: ResearchLifecycle::Draft,
            test_scenarios: vec![StrategyTestScenario {
                name: "confirmed rebound".into(),
                inputs: BTreeMap::from([("rebound-confirmation".into(), Value::Bool(true))]),
                expected_match: true,
                expected_action: Some("review_sell_gap".into()),
            }],
        };
        assert_eq!(
            draft.clone().publish(),
            Err(DslError::InvalidLifecycleTransition)
        );
        let validated = draft.validate().unwrap();
        assert_eq!(validated.lifecycle, ResearchLifecycle::Validated);
        assert_eq!(
            validated.publish().unwrap().lifecycle,
            ResearchLifecycle::Published
        );
    }

    #[test]
    fn typed_conditions_state_machine_and_scenarios_replay_deterministically() {
        let draft = StrategyDraft {
            schema_version: 1,
            strategy_id: "xiaomi-stage-4".into(),
            version: "1".into(),
            condition: Condition::All {
                conditions: vec![
                    Condition::TypedMetricComparison {
                        metric: MetricReference {
                            name: "base_irr".into(),
                            value_type: MetricValueType::Percentage,
                            unit: Some("percent".into()),
                        },
                        operator: Comparison::GreaterOrEqual,
                        value: 15.0,
                    },
                    Condition::Band {
                        metric: MetricReference {
                            name: "bear_downside".into(),
                            value_type: MetricValueType::Percentage,
                            unit: Some("percent".into()),
                        },
                        minimum: Some(0.0),
                        maximum: Some(25.0),
                    },
                    Condition::PortfolioConstraint {
                        metric: MetricReference {
                            name: "single_name_weight".into(),
                            value_type: MetricValueType::Percentage,
                            unit: Some("percent".into()),
                        },
                        operator: Comparison::LessOrEqual,
                        value: 80.0,
                    },
                    Condition::TimeComparison {
                        field: "as_of".into(),
                        operator: TimeComparison::OnOrBefore,
                        value: NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
                    },
                    Condition::ManualChecklist {
                        checklist_id: "stage4".into(),
                        items: vec!["macro".into(), "valuation".into()],
                    },
                    Condition::StateMachine {
                        machine_id: "stage_state".into(),
                        states: vec!["waiting".into(), "ready".into()],
                        transitions: vec![StateTransition {
                            from: "waiting".into(),
                            to: "ready".into(),
                            when: Box::new(Condition::HumanConfirmation {
                                checklist_id: "stage4-confirmed".into(),
                            }),
                        }],
                    },
                ],
            },
            suggestion: SuggestedAction {
                action: "review_sell_gap".into(),
                reason_code: "STAGE_4_READY".into(),
                invalidation: "thesis_invalidated".into(),
            },
            lifecycle: ResearchLifecycle::Draft,
            test_scenarios: vec![StrategyTestScenario {
                name: "all gates pass".into(),
                inputs: BTreeMap::from([
                    ("base_irr".into(), Value::from(15.0)),
                    ("bear_downside".into(), Value::from(25.0)),
                    ("single_name_weight".into(), Value::from(80.0)),
                    ("as_of".into(), Value::from("2026-08-17")),
                    ("stage4.macro".into(), Value::Bool(true)),
                    ("stage4.valuation".into(), Value::Bool(true)),
                    ("stage_state".into(), Value::from("waiting")),
                    ("stage4-confirmed".into(), Value::Bool(true)),
                ]),
                expected_match: true,
                expected_action: Some("review_sell_gap".into()),
            }],
        };

        let first = draft.replay_test_scenarios();
        let second = draft.replay_test_scenarios();
        assert_eq!(first, second);
        assert!(first[0].passed);
        assert_eq!(
            draft.validate().unwrap().lifecycle,
            ResearchLifecycle::Validated
        );
    }

    #[test]
    fn failing_scenario_and_invalid_transition_are_rejected() {
        let mut draft = StrategyDraft {
            schema_version: 1,
            strategy_id: "invalid-machine".into(),
            version: "1".into(),
            condition: Condition::StateMachine {
                machine_id: "state".into(),
                states: vec!["waiting".into()],
                transitions: vec![StateTransition {
                    from: "waiting".into(),
                    to: "missing".into(),
                    when: Box::new(Condition::HumanConfirmation {
                        checklist_id: "confirmed".into(),
                    }),
                }],
            },
            suggestion: SuggestedAction {
                action: "review".into(),
                reason_code: "TEST".into(),
                invalidation: "stale".into(),
            },
            lifecycle: ResearchLifecycle::Draft,
            test_scenarios: vec![],
        };
        assert_eq!(
            draft.validate_as_draft(),
            Err(DslError::InvalidConditionTree)
        );

        draft.condition = Condition::HumanConfirmation {
            checklist_id: "confirmed".into(),
        };
        draft.test_scenarios = vec![StrategyTestScenario {
            name: "must fail".into(),
            inputs: BTreeMap::from([("confirmed".into(), Value::Bool(false))]),
            expected_match: true,
            expected_action: Some("review".into()),
        }];
        assert_eq!(draft.validate(), Err(DslError::MissingOrFailingScenarios));
    }
}

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecisionSnapshot {
    pub profile_id: String,
    pub strategy_version: String,
    pub engine_version: String,
    pub facts: BTreeMap<String, String>,
}

impl DecisionSnapshot {
    pub fn decision_key(&self) -> String {
        let canonical =
            serde_json::to_vec(self).expect("serializing a decision snapshot cannot fail");
        hex::encode(Sha256::digest(canonical))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecommendationStatus {
    Proposed,
    Accepted,
    Rejected,
    PartiallyFilled,
    Filled,
    Superseded,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recommendation {
    pub decision_key: String,
    pub snapshot: DecisionSnapshot,
    pub status: RecommendationStatus,
    pub target_quantity: Decimal,
    pub filled_quantity: Decimal,
    pub resolution_reason: Option<String>,
    pub superseded_by: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid recommendation transition from {from:?} to {to:?}")]
pub struct InvalidTransition {
    pub from: RecommendationStatus,
    pub to: RecommendationStatus,
}

impl Recommendation {
    pub fn proposed(snapshot: DecisionSnapshot, target_quantity: Decimal) -> Self {
        Self {
            decision_key: snapshot.decision_key(),
            snapshot,
            status: RecommendationStatus::Proposed,
            target_quantity,
            filled_quantity: Decimal::ZERO,
            resolution_reason: None,
            superseded_by: None,
        }
    }

    pub fn transition(&mut self, next: RecommendationStatus) -> Result<(), InvalidTransition> {
        use RecommendationStatus::*;
        let valid = matches!(
            (self.status, next),
            (Proposed, Accepted | Rejected | Superseded | Expired)
                | (Accepted, PartiallyFilled | Filled | Superseded | Expired)
                | (
                    PartiallyFilled,
                    PartiallyFilled | Filled | Superseded | Expired
                )
        );
        if !valid {
            return Err(InvalidTransition {
                from: self.status,
                to: next,
            });
        }
        self.status = next;
        Ok(())
    }

    pub fn accept(&mut self) -> Result<(), InvalidTransition> {
        self.transition(RecommendationStatus::Accepted)
    }

    pub fn reject(&mut self, reason: impl Into<String>) -> Result<(), InvalidTransition> {
        self.transition(RecommendationStatus::Rejected)?;
        self.resolution_reason = Some(reason.into());
        Ok(())
    }

    pub fn record_fill(&mut self, quantity: Decimal) -> Result<(), InvalidTransition> {
        use RecommendationStatus::*;
        if quantity <= Decimal::ZERO || !matches!(self.status, Accepted | PartiallyFilled) {
            return Err(InvalidTransition {
                from: self.status,
                to: PartiallyFilled,
            });
        }
        self.filled_quantity += quantity;
        let next = if self.filled_quantity >= self.target_quantity {
            Filled
        } else {
            PartiallyFilled
        };
        self.transition(next)
    }

    pub fn supersede(
        &mut self,
        replacement_key: impl Into<String>,
    ) -> Result<(), InvalidTransition> {
        self.transition(RecommendationStatus::Superseded)?;
        self.superseded_by = Some(replacement_key.into());
        Ok(())
    }

    pub fn replay_is_deterministic(&self) -> bool {
        self.decision_key == self.snapshot.decision_key()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_snapshot_is_stable() {
        let mut facts_a = BTreeMap::new();
        facts_a.insert("quantity".into(), "213600".into());
        facts_a.insert("cash".into(), "395000".into());
        let mut facts_b = BTreeMap::new();
        facts_b.insert("cash".into(), "395000".into());
        facts_b.insert("quantity".into(), "213600".into());
        let a = DecisionSnapshot {
            profile_id: "p".into(),
            strategy_version: "s1".into(),
            engine_version: "e1".into(),
            facts: facts_a,
        };
        let b = DecisionSnapshot {
            facts: facts_b,
            ..a.clone()
        };
        assert_eq!(a.decision_key(), b.decision_key());
    }

    #[test]
    fn filled_recommendation_cannot_be_reopened() {
        let snapshot = DecisionSnapshot {
            profile_id: "p".into(),
            strategy_version: "s".into(),
            engine_version: "e".into(),
            facts: BTreeMap::new(),
        };
        let mut item = Recommendation::proposed(snapshot, Decimal::from(100));
        item.accept().unwrap();
        item.record_fill(Decimal::from(100)).unwrap();
        assert!(item.transition(RecommendationStatus::Accepted).is_err());
    }

    #[test]
    fn acceptance_and_execution_are_separate_and_partial_fills_accumulate() {
        let snapshot = DecisionSnapshot {
            profile_id: "p".into(),
            strategy_version: "s".into(),
            engine_version: "e".into(),
            facts: BTreeMap::new(),
        };
        let mut item = Recommendation::proposed(snapshot, Decimal::from(10_560));
        assert!(item.record_fill(Decimal::from(5_000)).is_err());
        item.accept().unwrap();
        item.record_fill(Decimal::from(5_000)).unwrap();
        assert_eq!(item.status, RecommendationStatus::PartiallyFilled);
        item.record_fill(Decimal::from(5_560)).unwrap();
        assert_eq!(item.status, RecommendationStatus::Filled);
        assert!(item.replay_is_deterministic());
    }
}

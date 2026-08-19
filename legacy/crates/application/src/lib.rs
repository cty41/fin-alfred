use fin_alfred_domain::{DecisionSnapshot, Execution, Ledger, LedgerError, Recommendation};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;

mod llm;
mod market_data;
pub use llm::*;
pub use market_data::*;
use std::sync::{Arc, Mutex};

pub trait LedgerRepository: Send + Sync {
    fn load(&self, profile_id: &str) -> anyhow::Result<Ledger>;
    fn save_execution_atomically(
        &self,
        ledger: &Ledger,
        execution: &Execution,
    ) -> anyhow::Result<()>;
}

pub trait RecommendationRepository: Send + Sync {
    fn find_by_decision_key(&self, key: &str) -> anyhow::Result<Option<Recommendation>>;
    fn insert(&self, recommendation: &Recommendation) -> anyhow::Result<()>;
}

pub struct DecisionService<R> {
    repository: R,
}

impl<R: RecommendationRepository> DecisionService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn create(&self, snapshot: &DecisionSnapshot) -> anyhow::Result<Recommendation> {
        let key = snapshot.decision_key();
        if let Some(existing) = self.repository.find_by_decision_key(&key)? {
            return Ok(existing);
        }
        let target_quantity = snapshot
            .facts
            .get("recommended_quantity")
            .and_then(|value| Decimal::from_str(value).ok())
            .unwrap_or(Decimal::ZERO);
        let recommendation = Recommendation::proposed(snapshot.clone(), target_quantity);
        self.repository.insert(&recommendation)?;
        Ok(recommendation)
    }
}

#[derive(Default, Clone)]
pub struct InMemoryRecommendationRepository {
    values: Arc<Mutex<HashMap<String, Recommendation>>>,
}

impl RecommendationRepository for InMemoryRecommendationRepository {
    fn find_by_decision_key(&self, key: &str) -> anyhow::Result<Option<Recommendation>> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn insert(&self, item: &Recommendation) -> anyhow::Result<()> {
        self.values
            .lock()
            .unwrap()
            .entry(item.decision_key.clone())
            .or_insert_with(|| item.clone());
        Ok(())
    }
}

pub fn apply_execution(ledger: &mut Ledger, execution: &Execution) -> Result<bool, LedgerError> {
    Ok(matches!(
        ledger.apply(execution)?,
        fin_alfred_domain::ApplyResult::Applied
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn repeated_decision_creation_returns_same_record() {
        let service = DecisionService::new(InMemoryRecommendationRepository::default());
        let snapshot = DecisionSnapshot {
            profile_id: "p".into(),
            strategy_version: "v1".into(),
            engine_version: "e1".into(),
            facts: BTreeMap::new(),
        };
        let first = service.create(&snapshot).unwrap();
        let second = service.create(&snapshot).unwrap();
        assert_eq!(first, second);
    }
}

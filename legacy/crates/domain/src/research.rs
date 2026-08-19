use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataOrigin {
    Provider,
    Manual,
    Filing,
    Derived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketQuoteSnapshot {
    pub profile_id: String,
    pub instrument_id: String,
    pub price: Decimal,
    pub currency: String,
    pub observed_at: DateTime<Utc>,
    pub valid_until: DateTime<Utc>,
    pub origin: DataOrigin,
    pub source_label: String,
}

impl MarketQuoteSnapshot {
    pub fn is_fresh_at(&self, now: DateTime<Utc>) -> bool {
        self.observed_at <= now && now <= self.valid_until
    }

    pub fn content_hash(&self) -> String {
        stable_hash(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FundamentalSnapshot {
    pub profile_id: String,
    pub instrument_id: String,
    pub period_end: NaiveDate,
    pub published_at: NaiveDate,
    pub valid_until: NaiveDate,
    pub source_label: String,
    pub metrics: BTreeMap<String, Option<Decimal>>,
}

impl FundamentalSnapshot {
    pub fn has_unknowns(&self) -> bool {
        self.metrics.values().any(Option::is_none)
    }

    pub fn content_hash(&self) -> String {
        stable_hash(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SotpComponent {
    pub name: String,
    pub bear_value: Decimal,
    pub base_value: Decimal,
    pub bull_value: Decimal,
    pub confidence: Confidence,
    pub evidence_reference: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SotpValuation {
    pub profile_id: String,
    pub instrument_id: String,
    pub as_of: NaiveDate,
    pub review_due: NaiveDate,
    pub components: Vec<SotpComponent>,
    pub group_adjustment: SotpComponent,
    pub diluted_shares: Decimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioValues {
    pub bear_equity: Decimal,
    pub base_equity: Decimal,
    pub bull_equity: Decimal,
    pub bear_per_share: Decimal,
    pub base_per_share: Decimal,
    pub bull_per_share: Decimal,
}

impl SotpValuation {
    pub fn scenarios(&self) -> Option<ScenarioValues> {
        if self.diluted_shares <= Decimal::ZERO || self.review_due < self.as_of {
            return None;
        }
        let bear = self
            .components
            .iter()
            .map(|item| item.bear_value)
            .sum::<Decimal>()
            + self.group_adjustment.bear_value;
        let base = self
            .components
            .iter()
            .map(|item| item.base_value)
            .sum::<Decimal>()
            + self.group_adjustment.base_value;
        let bull = self
            .components
            .iter()
            .map(|item| item.bull_value)
            .sum::<Decimal>()
            + self.group_adjustment.bull_value;
        Some(ScenarioValues {
            bear_equity: bear,
            base_equity: base,
            bull_equity: bull,
            bear_per_share: bear / self.diluted_shares,
            base_per_share: base / self.diluted_shares,
            bull_per_share: bull / self.diluted_shares,
        })
    }

    pub fn content_hash(&self) -> String {
        stable_hash(self)
    }
}

pub fn expected_annualized_return(
    current_price: Decimal,
    terminal_value: Decimal,
    cumulative_dividends: Decimal,
    years: u32,
) -> Option<Decimal> {
    if current_price <= Decimal::ZERO
        || terminal_value + cumulative_dividends <= Decimal::ZERO
        || years == 0
    {
        return None;
    }
    let target = (terminal_value + cumulative_dividends) / current_price;
    let mut low = Decimal::new(-99, 2);
    let mut high = Decimal::from(10);
    for _ in 0..128 {
        let mid = (low + high) / Decimal::from(2);
        let mut compounded = Decimal::ONE;
        for _ in 0..years {
            compounded *= Decimal::ONE + mid;
        }
        if compounded < target {
            low = mid
        } else {
            high = mid
        }
    }
    Some((low + high) / Decimal::from(2))
}

fn stable_hash<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("research snapshots are serializable");
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn manual_quote_is_explicit_and_expires() {
        let observed = Utc.with_ymd_and_hms(2026, 8, 17, 10, 0, 0).unwrap();
        let quote = MarketQuoteSnapshot {
            profile_id: "p".into(),
            instrument_id: "HKEX:1810".into(),
            price: Decimal::new(2562, 2),
            currency: "HKD".into(),
            observed_at: observed,
            valid_until: observed + chrono::Duration::hours(24),
            origin: DataOrigin::Manual,
            source_label: "user entry".into(),
        };
        assert!(quote.is_fresh_at(observed + chrono::Duration::hours(1)));
        assert!(!quote.is_fresh_at(observed + chrono::Duration::hours(25)));
        assert_eq!(quote.origin, DataOrigin::Manual);
    }

    #[test]
    fn sotp_and_irr_are_deterministic() {
        let component = |name: &str, bear, base, bull| SotpComponent {
            name: name.into(),
            bear_value: Decimal::from(bear),
            base_value: Decimal::from(base),
            bull_value: Decimal::from(bull),
            confidence: Confidence::Medium,
            evidence_reference: "fixture".into(),
        };
        let valuation = SotpValuation {
            profile_id: "p".into(),
            instrument_id: "HKEX:1810".into(),
            as_of: NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
            review_due: NaiveDate::from_ymd_opt(2026, 11, 30).unwrap(),
            components: vec![
                component("Smartphone", 100, 120, 150),
                component("EV", 20, 50, 100),
            ],
            group_adjustment: component("Net cash and group adjustment", 10, 10, 10),
            diluted_shares: Decimal::from(10),
        };
        let scenarios = valuation.scenarios().unwrap();
        assert_eq!(scenarios.base_per_share, Decimal::from(18));
        let irr =
            expected_annualized_return(Decimal::from(100), Decimal::from(121), Decimal::ZERO, 2)
                .unwrap();
        assert!((irr - Decimal::new(10, 2)).abs() < Decimal::new(1, 6));
        assert_eq!(valuation.content_hash(), valuation.content_hash());
    }

    #[test]
    fn unknown_fundamental_metric_is_not_neutral() {
        let mut metrics = BTreeMap::new();
        metrics.insert("ev_gross_margin".into(), None);
        let snapshot = FundamentalSnapshot {
            profile_id: "p".into(),
            instrument_id: "HKEX:1810".into(),
            period_end: NaiveDate::from_ymd_opt(2026, 6, 30).unwrap(),
            published_at: NaiveDate::from_ymd_opt(2026, 8, 1).unwrap(),
            valid_until: NaiveDate::from_ymd_opt(2026, 11, 30).unwrap(),
            source_label: "filing".into(),
            metrics,
        };
        assert!(snapshot.has_unknowns());
    }
}

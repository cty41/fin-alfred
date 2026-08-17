use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::min;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateState {
    Clear,
    Yellow,
    Red,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceScore {
    Zero,
    One,
    Two,
    Three,
    Four,
    Unknown,
}

impl EvidenceScore {
    fn numeric(self) -> Option<u8> {
        match self {
            Self::Zero => Some(0),
            Self::One => Some(1),
            Self::Two => Some(2),
            Self::Three => Some(3),
            Self::Four => Some(4),
            Self::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeightedCriterion {
    pub name: String,
    pub weight: u8,
    pub score: EvidenceScore,
    pub critical: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackScore {
    pub score: Option<u8>,
    pub has_unknown: bool,
    pub minimum_critical: Option<u8>,
}

pub fn score_track(criteria: &[WeightedCriterion]) -> TrackScore {
    let has_unknown = criteria
        .iter()
        .any(|item| item.score == EvidenceScore::Unknown);
    let total_weight: u32 = criteria.iter().map(|item| item.weight as u32).sum();
    let score = if has_unknown || total_weight == 0 {
        None
    } else {
        let weighted: u32 = criteria
            .iter()
            .map(|item| item.weight as u32 * item.score.numeric().unwrap_or_default() as u32)
            .sum();
        Some(((weighted * 100) / (total_weight * 4)) as u8)
    };
    let minimum_critical = criteria
        .iter()
        .filter(|item| item.critical)
        .filter_map(|item| item.score.numeric())
        .min();
    TrackScore {
        score,
        has_unknown,
        minimum_critical,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QualityBand {
    Research,
    Qualified,
    HighQuality,
    Core,
}

pub fn quality_band(combined_score: u8, minimum_critical: u8) -> QualityBand {
    match combined_score {
        85..=u8::MAX if minimum_critical >= 3 => QualityBand::Core,
        70..=u8::MAX if minimum_critical >= 2 => QualityBand::HighQuality,
        60..=u8::MAX => QualityBand::Qualified,
        _ => QualityBand::Research,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiLuAssessment {
    pub moat: EvidenceScore,
    pub incremental_roic: EvidenceScore,
    pub cash_conversion: EvidenceScore,
    pub management_and_allocation: EvidenceScore,
    pub balance_sheet: EvidenceScore,
    pub runway: EvidenceScore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BurryAssessment {
    pub valuation_discount: EvidenceScore,
    pub bear_protection: EvidenceScore,
    pub balance_sheet: EvidenceScore,
    pub normalized_fcf: EvidenceScore,
    pub expectation_gap: EvidenceScore,
    pub catalyst: EvidenceScore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XiaomiValueAssessment {
    pub gate: GateState,
    pub li_lu: LiLuAssessment,
    pub burry: BurryAssessment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XiaomiAssessmentResult {
    pub li_lu_score: TrackScore,
    pub burry_score: TrackScore,
    pub combined_score: Option<u8>,
    pub band: Option<QualityBand>,
    pub minimum_position_percent: u8,
    pub maximum_position_percent: u8,
    pub exit_review_required: bool,
}

impl XiaomiValueAssessment {
    pub fn content_hash(&self) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("value assessment is serializable"),
        ))
    }

    pub fn evaluate(&self) -> XiaomiAssessmentResult {
        let li_lu_score = score_track(&[
            criterion("moat", 25, self.li_lu.moat, true),
            criterion("incremental_roic", 25, self.li_lu.incremental_roic, true),
            criterion("cash_conversion", 15, self.li_lu.cash_conversion, false),
            criterion(
                "management_and_allocation",
                15,
                self.li_lu.management_and_allocation,
                true,
            ),
            criterion("balance_sheet", 10, self.li_lu.balance_sheet, true),
            criterion("runway", 10, self.li_lu.runway, false),
        ]);
        let burry_score = score_track(&[
            criterion(
                "valuation_discount",
                25,
                self.burry.valuation_discount,
                true,
            ),
            criterion("bear_protection", 25, self.burry.bear_protection, true),
            criterion("balance_sheet", 15, self.burry.balance_sheet, true),
            criterion("normalized_fcf", 15, self.burry.normalized_fcf, true),
            criterion("expectation_gap", 10, self.burry.expectation_gap, false),
            criterion("catalyst", 10, self.burry.catalyst, false),
        ]);
        let combined_score = li_lu_score
            .score
            .zip(burry_score.score)
            .map(|(li_lu, burry)| ((u16::from(li_lu) + u16::from(burry)) / 2) as u8);
        let minimum_critical = li_lu_score
            .minimum_critical
            .zip(burry_score.minimum_critical)
            .map(|(left, right)| min(left, right));
        let band = combined_score
            .zip(minimum_critical)
            .map(|(score, critical)| quality_band(score, critical));
        let (minimum_position_percent, mut maximum_position_percent) = match band {
            Some(QualityBand::Qualified) => (5, 15),
            Some(QualityBand::HighQuality) => (15, 30),
            Some(QualityBand::Core) => (30, 80),
            Some(QualityBand::Research) | None => (0, 5),
        };
        let exit_review_required = self.gate == GateState::Red;
        if exit_review_required {
            maximum_position_percent = 0;
        } else if self.gate == GateState::Yellow {
            maximum_position_percent = min(maximum_position_percent, 25);
        }
        XiaomiAssessmentResult {
            li_lu_score,
            burry_score,
            combined_score,
            band,
            minimum_position_percent: if exit_review_required {
                0
            } else {
                minimum_position_percent
            },
            maximum_position_percent,
            exit_review_required,
        }
    }
}

fn criterion(name: &str, weight: u8, score: EvidenceScore, critical: bool) -> WeightedCriterion {
    WeightedCriterion {
        name: name.into(),
        weight,
        score,
        critical,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValuationGuard {
    pub gate: GateState,
    pub price: Decimal,
    pub base_value: Decimal,
    pub base_irr: Decimal,
    pub bear_downside: Decimal,
    pub balance_sheet_safe: bool,
    pub fresh: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CashDeploymentGuard {
    pub red_line_clear: bool,
    pub evidence_complete: bool,
    pub valuation_current: bool,
    pub expected_irr: Decimal,
    pub bear_downside: Decimal,
    pub balance_sheet_safe: bool,
    pub liquidity_reserve_met: bool,
    pub resulting_single_name_weight: Decimal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReverseDcfSnapshot {
    pub profile_id: String,
    pub instrument_id: String,
    pub as_of: chrono::NaiveDate,
    pub review_due: chrono::NaiveDate,
    pub enterprise_value: Decimal,
    pub starting_free_cash_flow: Decimal,
    /// Decimal fraction: 0.10 means 10%.
    pub discount_rate: Decimal,
    pub terminal_multiple: Decimal,
    pub years: u32,
    pub evidence_reference: String,
}

impl ReverseDcfSnapshot {
    pub fn implied_fcf_growth(&self) -> Option<Decimal> {
        if self.enterprise_value <= Decimal::ZERO
            || self.starting_free_cash_flow <= Decimal::ZERO
            || self.discount_rate <= Decimal::new(-99, 2)
            || self.terminal_multiple < Decimal::ZERO
            || self.years == 0
            || self.review_due < self.as_of
        {
            return None;
        }
        let present_value = |growth: Decimal| {
            let mut fcf = self.starting_free_cash_flow;
            let mut discount = Decimal::ONE;
            let mut value = Decimal::ZERO;
            for _ in 1..=self.years {
                fcf *= Decimal::ONE + growth;
                discount *= Decimal::ONE + self.discount_rate;
                value += fcf / discount;
            }
            value + (fcf * self.terminal_multiple / discount)
        };
        let mut low = Decimal::new(-99, 2);
        let mut high = Decimal::from(10);
        if present_value(low) > self.enterprise_value || present_value(high) < self.enterprise_value
        {
            return None;
        }
        for _ in 0..160 {
            let middle = (low + high) / Decimal::from(2);
            if present_value(middle) < self.enterprise_value {
                low = middle;
            } else {
                high = middle;
            }
        }
        Some((low + high) / Decimal::from(2))
    }

    pub fn content_hash(&self) -> String {
        hex::encode(Sha256::digest(
            serde_json::to_vec(self).expect("reverse DCF snapshot is serializable"),
        ))
    }
}

impl CashDeploymentGuard {
    pub fn can_deploy(&self) -> bool {
        self.red_line_clear
            && self.evidence_complete
            && self.valuation_current
            && self.expected_irr >= Decimal::new(15, 2)
            && self.bear_downside <= Decimal::new(25, 2)
            && self.balance_sheet_safe
            && self.liquidity_reserve_met
            && self.resulting_single_name_weight <= Decimal::new(80, 2)
    }
}

impl ValuationGuard {
    pub fn can_add_risk(&self) -> bool {
        self.gate != GateState::Red
            && self.price < self.base_value
            && self.base_irr >= Decimal::new(15, 2)
            && self.bear_downside <= Decimal::new(25, 2)
            && self.balance_sheet_safe
            && self.fresh
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_is_not_scored_as_neutral() {
        let result = score_track(&[
            WeightedCriterion {
                name: "moat".into(),
                weight: 25,
                score: EvidenceScore::Four,
                critical: true,
            },
            WeightedCriterion {
                name: "reinvestment".into(),
                weight: 25,
                score: EvidenceScore::Unknown,
                critical: true,
            },
        ]);
        assert_eq!(result.score, None);
        assert!(result.has_unknown);
    }

    #[test]
    fn critical_gate_prevents_core_classification() {
        assert_eq!(quality_band(90, 2), QualityBand::HighQuality);
        assert_eq!(quality_band(90, 3), QualityBand::Core);
    }

    #[test]
    fn sale_cash_is_not_automatically_redeployed() {
        let guard = CashDeploymentGuard {
            red_line_clear: true,
            evidence_complete: false,
            valuation_current: true,
            expected_irr: Decimal::new(20, 2),
            bear_downside: Decimal::new(20, 2),
            balance_sheet_safe: true,
            liquidity_reserve_met: true,
            resulting_single_name_weight: Decimal::new(30, 2),
        };
        assert!(!guard.can_deploy());
    }

    fn score(value: EvidenceScore) -> XiaomiValueAssessment {
        XiaomiValueAssessment {
            gate: GateState::Clear,
            li_lu: LiLuAssessment {
                moat: value,
                incremental_roic: value,
                cash_conversion: value,
                management_and_allocation: value,
                balance_sheet: value,
                runway: value,
            },
            burry: BurryAssessment {
                valuation_discount: value,
                bear_protection: value,
                balance_sheet: value,
                normalized_fcf: value,
                expectation_gap: value,
                catalyst: value,
            },
        }
    }

    #[test]
    fn xiaomi_two_track_weights_and_position_bands_are_enforced() {
        let result = score(EvidenceScore::Four).evaluate();
        assert_eq!(result.li_lu_score.score, Some(100));
        assert_eq!(result.burry_score.score, Some(100));
        assert_eq!(result.combined_score, Some(100));
        assert_eq!(result.band, Some(QualityBand::Core));
        assert_eq!(
            (
                result.minimum_position_percent,
                result.maximum_position_percent
            ),
            (30, 80)
        );

        let mut yellow = score(EvidenceScore::Four);
        yellow.gate = GateState::Yellow;
        assert_eq!(yellow.evaluate().maximum_position_percent, 25);
        let mut red = score(EvidenceScore::Four);
        red.gate = GateState::Red;
        let red = red.evaluate();
        assert!(red.exit_review_required);
        assert_eq!(red.maximum_position_percent, 0);
    }

    #[test]
    fn xiaomi_unknown_and_low_critical_scores_cannot_be_core() {
        let mut unknown = score(EvidenceScore::Four);
        unknown.li_lu.cash_conversion = EvidenceScore::Unknown;
        let unknown = unknown.evaluate();
        assert_eq!(unknown.combined_score, None);
        assert_eq!(unknown.maximum_position_percent, 5);

        let mut weak_critical = score(EvidenceScore::Four);
        weak_critical.burry.bear_protection = EvidenceScore::Two;
        let weak = weak_critical.evaluate();
        assert_ne!(weak.band, Some(QualityBand::Core));
    }

    #[test]
    fn reverse_dcf_solves_the_market_implied_fcf_growth_deterministically() {
        let snapshot = ReverseDcfSnapshot {
            profile_id: "p".into(),
            instrument_id: "HKEX:1810".into(),
            as_of: chrono::NaiveDate::from_ymd_opt(2026, 8, 17).unwrap(),
            review_due: chrono::NaiveDate::from_ymd_opt(2026, 11, 30).unwrap(),
            enterprise_value: Decimal::from(1500),
            starting_free_cash_flow: Decimal::from(100),
            discount_rate: Decimal::new(10, 2),
            terminal_multiple: Decimal::from(10),
            years: 5,
            evidence_reference: "test".into(),
        };
        let growth = snapshot.implied_fcf_growth().unwrap();
        assert!((growth - Decimal::new(10, 2)).abs() < Decimal::new(1, 3));
        assert_eq!(snapshot.content_hash(), snapshot.content_hash());
    }
}

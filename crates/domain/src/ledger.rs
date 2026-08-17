use chrono::NaiveDate;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Money {
    pub amount: Decimal,
    pub currency: String,
}

impl Money {
    pub fn hkd(amount: Decimal) -> Self {
        Self {
            amount,
            currency: "HKD".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeBreakdown {
    pub stamp_duty: Decimal,
    pub clearing_fee: Decimal,
    pub transfer_fee: Decimal,
    pub commission: Decimal,
}

impl FeeBreakdown {
    pub fn total(&self) -> Decimal {
        self.stamp_duty + self.clearing_fee + self.transfer_fee + self.commission
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Execution {
    pub instrument_id: String,
    pub side: Side,
    pub traded_at: NaiveDate,
    pub quantity: Decimal,
    pub price: Decimal,
    pub fees: FeeBreakdown,
    pub external_id: Option<String>,
}

impl Execution {
    pub fn gross_amount(&self) -> Decimal {
        self.quantity * self.price
    }

    pub fn net_cash_flow(&self) -> Decimal {
        match self.side {
            Side::Sell => self.gross_amount() - self.fees.total(),
            Side::Buy => -(self.gross_amount() + self.fees.total()),
        }
    }

    pub fn execution_key(&self, profile_id: &str) -> String {
        let stable = format!(
            "{profile_id}|{}|{:?}|{}|{}|{}|{}",
            self.instrument_id,
            self.side,
            self.traded_at,
            self.quantity.normalize(),
            self.price.normalize(),
            self.external_id.as_deref().unwrap_or("")
        );
        hex::encode(Sha256::digest(stable.as_bytes()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    pub profile_id: String,
    pub instrument_id: String,
    pub quantity: Decimal,
    pub cash: Decimal,
    applied_execution_keys: BTreeSet<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LedgerError {
    #[error(
        "execution quantity, price, and fees must be non-negative with positive quantity and price"
    )]
    InvalidExecution,
    #[error("execution instrument does not match ledger")]
    InstrumentMismatch,
    #[error("execution would make the position negative")]
    InsufficientPosition,
    #[error("execution would make cash negative")]
    InsufficientCash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyResult {
    Applied,
    Duplicate,
}

impl Ledger {
    pub fn new(
        profile_id: impl Into<String>,
        instrument_id: impl Into<String>,
        quantity: Decimal,
        cash: Decimal,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            instrument_id: instrument_id.into(),
            quantity,
            cash,
            applied_execution_keys: BTreeSet::new(),
        }
    }

    pub fn apply(&mut self, execution: &Execution) -> Result<ApplyResult, LedgerError> {
        if execution.instrument_id != self.instrument_id {
            return Err(LedgerError::InstrumentMismatch);
        }
        if execution.quantity <= Decimal::ZERO
            || execution.price <= Decimal::ZERO
            || execution.fees.stamp_duty < Decimal::ZERO
            || execution.fees.clearing_fee < Decimal::ZERO
            || execution.fees.transfer_fee < Decimal::ZERO
            || execution.fees.commission < Decimal::ZERO
        {
            return Err(LedgerError::InvalidExecution);
        }
        let key = execution.execution_key(&self.profile_id);
        if self.applied_execution_keys.contains(&key) {
            return Ok(ApplyResult::Duplicate);
        }

        let next_quantity = match execution.side {
            Side::Sell => self.quantity - execution.quantity,
            Side::Buy => self.quantity + execution.quantity,
        };
        let next_cash = self.cash + execution.net_cash_flow();
        if next_quantity.is_sign_negative() {
            return Err(LedgerError::InsufficientPosition);
        }
        if next_cash.is_sign_negative() {
            return Err(LedgerError::InsufficientCash);
        }

        self.quantity = next_quantity;
        self.cash = next_cash;
        self.applied_execution_keys.insert(key);
        Ok(ApplyResult::Applied)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;
    use std::str::FromStr;

    fn d(value: &str) -> Decimal {
        Decimal::from_str(value).unwrap()
    }

    fn xiaomi_execution() -> Execution {
        Execution {
            instrument_id: "HKEX:1810".into(),
            side: Side::Sell,
            traded_at: NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
            quantity: d("12000"),
            price: d("25.62"),
            fees: FeeBreakdown {
                stamp_duty: d("270"),
                clearing_fee: d("22"),
                transfer_fee: d("11"),
                commission: d("26"),
            },
            external_id: None,
        }
    }

    #[test]
    fn xiaomi_real_execution_balances() {
        let execution = xiaomi_execution();
        assert_eq!(execution.gross_amount(), d("307440"));
        assert_eq!(execution.fees.total(), d("329"));
        assert_eq!(execution.net_cash_flow(), d("307111"));

        let mut ledger = Ledger::new("profile-xiaomi-real", "HKEX:1810", d("225600"), d("87889"));
        assert_eq!(ledger.apply(&execution).unwrap(), ApplyResult::Applied);
        assert_eq!(ledger.quantity, d("213600"));
        assert_eq!(ledger.cash, d("395000"));
    }

    #[test]
    fn duplicate_execution_is_idempotent() {
        let execution = xiaomi_execution();
        let mut ledger = Ledger::new("profile-xiaomi-real", "HKEX:1810", d("225600"), d("87889"));
        ledger.apply(&execution).unwrap();
        assert_eq!(ledger.apply(&execution).unwrap(), ApplyResult::Duplicate);
        assert_eq!(ledger.quantity, d("213600"));
        assert_eq!(ledger.cash, d("395000"));
    }
}

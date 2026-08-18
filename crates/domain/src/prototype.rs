use rust_decimal::prelude::FromPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentProfile {
    pub instrument_id: String,
    pub symbol: String,
    pub name: String,
    pub currency: String,
    pub announcement_url: String,
    pub investor_relations_url: String,
    pub buy_price: Option<String>,
    #[serde(default)]
    pub price_snapshots: Vec<PriceSnapshot>,
    pub manual_price_override: Option<PriceSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceSnapshot {
    pub price: String,
    pub previous_close: Option<String>,
    pub observed_at: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnualFinancials {
    pub instrument_id: String,
    pub year: i32,
    pub currency: String,
    pub revenue: String,
    pub net_income: String,
    pub cash: String,
    pub debt: String,
    pub equity: String,
    pub operating_cash_flow: String,
    pub capex: String,
    pub source_url: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcfScenarioInput {
    pub revenue_growth: String,
    pub ending_net_margin: String,
    pub cash_conversion: String,
    pub discount_rate: String,
    pub exit_pe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcfInput {
    pub instrument_id: String,
    pub starting_revenue: String,
    pub starting_net_margin: String,
    pub diluted_shares: String,
    pub forecast_years: u32,
    pub bear: DcfScenarioInput,
    pub base: DcfScenarioInput,
    pub bull: DcfScenarioInput,
    pub as_of: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcfProjectionRow {
    pub year: u32,
    pub revenue: String,
    pub net_margin: String,
    pub net_income: String,
    pub fcfe_proxy: String,
    pub discounted_fcfe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcfScenarioResult {
    pub value_per_share: String,
    pub pv_forecast_fcfe: String,
    pub pv_terminal_value: String,
    pub equity_value: String,
    pub terminal_value_share: String,
    pub projection: Vec<DcfProjectionRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DcfResult {
    pub input: DcfInput,
    pub bear: DcfScenarioResult,
    pub base: DcfScenarioResult,
    pub bull: DcfScenarioResult,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultipleSeries {
    pub current: Option<String>,
    pub three_year_median: Option<String>,
    pub five_year_median: Option<String>,
    pub peer_median: Option<String>,
    pub valid_observations: usize,
    pub percentile_10: Option<String>,
    pub percentile_90: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComparableInstrument {
    pub symbol: String,
    pub name: String,
    pub pe: Option<String>,
    pub pcf: Option<String>,
    pub included: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelativeInput {
    pub instrument_id: String,
    pub normalized_eps: String,
    pub normalized_ocf_per_share: String,
    pub pe: MultipleSeries,
    pub pcf: MultipleSeries,
    #[serde(default)]
    pub peers: Vec<ComparableInstrument>,
    pub source: String,
    pub fetched_at: Option<String>,
    pub as_of: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelativeResult {
    pub input: RelativeInput,
    pub bear: Option<String>,
    pub base: Option<String>,
    pub bull: Option<String>,
    pub confidence: String,
    pub implied_prices: Vec<ImpliedPrice>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImpliedPrice {
    pub metric: String,
    pub reference: String,
    pub multiple: String,
    pub price: String,
}

fn decimal(value: &str, label: &str) -> Result<Decimal, String> {
    Decimal::from_str(value).map_err(|_| format!("{label} must be a decimal"))
}

fn result_string(value: Decimal) -> String {
    value.round_dp(4).normalize().to_string()
}

fn project_scenario(
    input: &DcfInput,
    scenario: &DcfScenarioInput,
) -> Result<DcfScenarioResult, String> {
    if input.forecast_years == 0 || input.forecast_years > 20 {
        return Err("forecast years must be between 1 and 20".into());
    }
    let mut revenue = decimal(&input.starting_revenue, "starting revenue")?;
    let start_margin = decimal(&input.starting_net_margin, "starting net margin")?;
    let end_margin = decimal(&scenario.ending_net_margin, "ending net margin")?;
    let growth = decimal(&scenario.revenue_growth, "revenue growth")?;
    let conversion = decimal(&scenario.cash_conversion, "cash conversion")?;
    let discount = decimal(&scenario.discount_rate, "discount rate")?;
    let exit_pe = decimal(&scenario.exit_pe, "exit PE")?;
    let shares = decimal(&input.diluted_shares, "diluted shares")?;
    if revenue <= Decimal::ZERO
        || shares <= Decimal::ZERO
        || discount <= Decimal::ZERO
        || exit_pe <= Decimal::ZERO
    {
        return Err("revenue, shares, discount rate and exit PE must be positive".into());
    }
    let years = Decimal::from(input.forecast_years);
    let mut rows = Vec::new();
    let mut pv_fcfe = Decimal::ZERO;
    let mut final_income = Decimal::ZERO;
    for year in 1..=input.forecast_years {
        revenue *= Decimal::ONE + growth;
        let progress = Decimal::from(year) / years;
        let margin = start_margin + (end_margin - start_margin) * progress;
        let income = revenue * margin;
        let fcfe = income * conversion;
        let factor = decimal_pow(Decimal::ONE + discount, year);
        let discounted = fcfe / factor;
        pv_fcfe += discounted;
        final_income = income;
        rows.push(DcfProjectionRow {
            year,
            revenue: result_string(revenue),
            net_margin: result_string(margin),
            net_income: result_string(income),
            fcfe_proxy: result_string(fcfe),
            discounted_fcfe: result_string(discounted),
        });
    }
    let terminal = final_income * exit_pe;
    let pv_terminal = terminal / decimal_pow(Decimal::ONE + discount, input.forecast_years);
    let equity = pv_fcfe + pv_terminal;
    Ok(DcfScenarioResult {
        value_per_share: result_string(equity / shares),
        pv_forecast_fcfe: result_string(pv_fcfe),
        pv_terminal_value: result_string(pv_terminal),
        equity_value: result_string(equity),
        terminal_value_share: result_string(if equity.is_zero() {
            Decimal::ZERO
        } else {
            pv_terminal / equity
        }),
        projection: rows,
    })
}

pub fn calculate_dcf(input: DcfInput) -> Result<DcfResult, String> {
    let encoded = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    let content_hash = sha256(&encoded);
    Ok(DcfResult {
        bear: project_scenario(&input, &input.bear)?,
        base: project_scenario(&input, &input.base)?,
        bull: project_scenario(&input, &input.bull)?,
        input,
        content_hash,
    })
}

fn positive(value: &Option<String>) -> Option<Decimal> {
    value
        .as_deref()
        .and_then(|item| Decimal::from_str(item).ok())
        .filter(|item| *item > Decimal::ZERO)
}

pub fn calculate_relative(input: RelativeInput) -> Result<RelativeResult, String> {
    let eps = decimal(&input.normalized_eps, "normalized EPS")?;
    let ocf = decimal(&input.normalized_ocf_per_share, "normalized OCF per share")?;
    let mut implied = Vec::new();
    for (metric, basis, series) in [("P/E", eps, &input.pe), ("P/CF", ocf, &input.pcf)] {
        for (reference, multiple) in [
            ("3Y Median", positive(&series.three_year_median)),
            ("5Y Median", positive(&series.five_year_median)),
            ("Peer Median", positive(&series.peer_median)),
        ] {
            if let Some(multiple) = multiple {
                let price = basis * multiple;
                if price > Decimal::ZERO {
                    implied.push(ImpliedPrice {
                        metric: metric.into(),
                        reference: reference.into(),
                        multiple: result_string(multiple),
                        price: result_string(price),
                    });
                }
            }
        }
    }
    let mut values: Vec<Decimal> = implied
        .iter()
        .filter_map(|item| Decimal::from_str(&item.price).ok())
        .collect();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let base = median(&values);
    let encoded = serde_json::to_vec(&input).map_err(|error| error.to_string())?;
    Ok(RelativeResult {
        bear: base.map(|value| result_string(value * Decimal::new(8, 1))),
        base: base.map(result_string),
        bull: base.map(|value| result_string(value * Decimal::new(12, 1))),
        confidence: if values.len() >= 4
            && input.pe.valid_observations >= 120
            && input.pcf.valid_observations >= 120
        {
            "normal"
        } else if values.is_empty() {
            "insufficient"
        } else {
            "low"
        }
        .into(),
        implied_prices: implied,
        input,
        content_hash: sha256(&encoded),
    })
}

pub fn summarize_multiples(values: &[f64], years: f64) -> MultipleSeries {
    let mut valid: Vec<f64> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value > 0.0)
        .collect();
    valid.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let count = valid.len();
    let value = |number: Option<f64>| number.and_then(Decimal::from_f64).map(result_string);
    let median_value = percentile(&valid, 0.5);
    MultipleSeries {
        current: valid
            .last()
            .copied()
            .and_then(Decimal::from_f64)
            .map(result_string),
        three_year_median: if years >= 3.0 {
            value(median_value)
        } else {
            None
        },
        five_year_median: if years >= 5.0 {
            value(median_value)
        } else {
            None
        },
        peer_median: None,
        valid_observations: count,
        percentile_10: value(percentile(&valid, 0.1)),
        percentile_90: value(percentile(&valid, 0.9)),
    }
}

fn median(values: &[Decimal]) -> Option<Decimal> {
    if values.is_empty() {
        None
    } else if values.len() % 2 == 1 {
        Some(values[values.len() / 2])
    } else {
        Some((values[values.len() / 2 - 1] + values[values.len() / 2]) / Decimal::from(2))
    }
}

fn decimal_pow(base: Decimal, exponent: u32) -> Decimal {
    (0..exponent).fold(Decimal::ONE, |value, _| value * base)
}

fn percentile(values: &[f64], percentile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let position = ((values.len() - 1) as f64 * percentile).round() as usize;
    values.get(position).copied()
}

fn sha256(value: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenario(growth: &str, margin: &str) -> DcfScenarioInput {
        DcfScenarioInput {
            revenue_growth: growth.into(),
            ending_net_margin: margin.into(),
            cash_conversion: "0.9".into(),
            discount_rate: "0.09".into(),
            exit_pe: "17".into(),
        }
    }

    #[test]
    fn dcf_is_deterministic_and_projects_five_years() {
        let input = DcfInput {
            instrument_id: "HKEX:1810".into(),
            starting_revenue: "365000000000".into(),
            starting_net_margin: "0.058".into(),
            diluted_shares: "25000000000".into(),
            forecast_years: 5,
            bear: scenario("0.04", "0.06"),
            base: scenario("0.09", "0.082"),
            bull: scenario("0.14", "0.10"),
            as_of: "2026-08-18".into(),
        };
        let first = calculate_dcf(input.clone()).unwrap();
        let second = calculate_dcf(input).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.base.projection.len(), 5);
        assert!(
            Decimal::from_str(&first.bull.value_per_share).unwrap()
                > Decimal::from_str(&first.bear.value_per_share).unwrap()
        );
    }

    #[test]
    fn relative_ignores_current_multiple_and_uses_reference_median() {
        let series = MultipleSeries {
            current: Some("99".into()),
            three_year_median: Some("20".into()),
            five_year_median: Some("22".into()),
            peer_median: Some("24".into()),
            valid_observations: 500,
            percentile_10: Some("10".into()),
            percentile_90: Some("30".into()),
        };
        let result = calculate_relative(RelativeInput {
            instrument_id: "HKEX:1810".into(),
            normalized_eps: "1.5".into(),
            normalized_ocf_per_share: "1".into(),
            pe: series.clone(),
            pcf: series,
            peers: vec![],
            source: "fixture".into(),
            fetched_at: None,
            as_of: "2026-08-18".into(),
        })
        .unwrap();
        assert_eq!(result.implied_prices.len(), 6);
        assert_eq!(result.base.as_deref(), Some("27"));
    }
}

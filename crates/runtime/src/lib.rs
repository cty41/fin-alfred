use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{NaiveDate, Utc};
use fin_alfred_application::{
    quote_snapshot, AgentRequest, ContextManifest, JsonHttpMarketDataProvider, LlmProvider,
    MarketProviderConfig, OpenAiResponsesProvider, ProviderCapabilities, ProviderConfig,
    RecommendationRepository,
};
use fin_alfred_domain::{
    calculate_dcf, calculate_relative, expected_annualized_return, AgentPermission, AgentPolicy,
    AnnualFinancials, CashDeploymentGuard, Confidence, DataOrigin, DcfInput, DcfResult,
    DecisionSnapshot, EvidenceScore, Execution, FeeBreakdown, FundamentalSnapshot,
    InstrumentProfile, MarketQuoteSnapshot, MultipleSeries, PriceSnapshot, Recommendation,
    RelativeInput, RelativeResult, ReverseDcfSnapshot, Side, SotpValuation,
    StagedPositionTransition, StrategyDraft, StrategyOutcome, XiaomiSignals, XiaomiValueAssessment,
};
use fin_alfred_persistence::{EncryptedDatabase, LedgerSnapshot, ProfileCatalog, SCHEMA_VERSION};
use fin_alfred_platform::{
    create_profile_backup, decode_profile_backup, generate_database_key, InMemorySecretStore,
    SecretStore, SystemSecretStore,
};
use rand::RngCore;
use rust_decimal::Decimal;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::str::FromStr;
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use uuid::Uuid;
use zeroize::Zeroizing;

struct AppState {
    catalog: ProfileCatalog,
    profiles: RwLock<HashMap<String, ProfileHandle>>,
    profiles_directory: PathBuf,
    secret_store: Arc<dyn SecretStore>,
    deterministic_test_keys: bool,
}

struct ProfileHandle {
    name: String,
    database: Arc<EncryptedDatabase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInput {
    message: String,
    conversation_id: String,
    context: AgentInputContext,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentInputContext {
    profile_id: String,
    instrument_id: String,
}

const LLM_CONFIG_KEY: &str = "llm.provider-config";
const MARKET_CONFIG_KEY: &str = "market.provider-config";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileItem {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct XiaomiDecisionInput {
    profile_id: String,
    signals: XiaomiSignals,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualQuoteInput {
    profile_id: String,
    price: Decimal,
    observed_at: chrono::DateTime<Utc>,
    source_label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecisionExecutionInput {
    profile_id: String,
    decision_key: String,
    traded_at: NaiveDate,
    quantity: Decimal,
    price: Decimal,
    stamp_duty: Decimal,
    clearing_fee: Decimal,
    transfer_fee: Decimal,
    commission: Decimal,
    external_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LedgerBaselineInput {
    profile_id: String,
    quantity: Decimal,
    cash: Decimal,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualExecutionInput {
    profile_id: String,
    side: Side,
    traded_at: NaiveDate,
    quantity: Decimal,
    price: Decimal,
    stamp_duty: Decimal,
    clearing_fee: Decimal,
    transfer_fee: Decimal,
    commission: Decimal,
    external_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeeRevisionInput {
    profile_id: String,
    execution_key: String,
    stamp_duty: Decimal,
    clearing_fee: Decimal,
    transfer_fee: Decimal,
    commission: Decimal,
}

impl AppState {
    fn profile(&self, profile_id: &str) -> Result<(ProfileItem, Arc<EncryptedDatabase>), String> {
        let profiles = self
            .profiles
            .read()
            .map_err(|_| "档案锁不可用".to_string())?;
        let handle = profiles
            .get(profile_id)
            .ok_or_else(|| "投资档案不存在".to_string())?;
        Ok((
            ProfileItem {
                id: profile_id.into(),
                name: handle.name.clone(),
            },
            Arc::clone(&handle.database),
        ))
    }

    fn list_profile_items(&self) -> Result<Vec<ProfileItem>, String> {
        self.catalog
            .list()
            .map_err(|error| error.to_string())
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| ProfileItem {
                        id: item.id,
                        name: item.name,
                    })
                    .collect()
            })
    }

    fn secret_name(profile_id: &str, suffix: &str) -> String {
        format!("{profile_id}.{suffix}")
    }

    fn database_key(&self, profile_id: &str, create: bool) -> anyhow::Result<Vec<u8>> {
        if self.deterministic_test_keys {
            return Ok(Sha256::digest(format!("fin-alfred-test-key:{profile_id}")).to_vec());
        }
        let secret_name = Self::secret_name(profile_id, "database-key");
        match self.secret_store.get(&secret_name)? {
            Some(value) => Ok(value),
            None if create => {
                let value = generate_database_key().to_vec();
                self.secret_store.put(&secret_name, &value)?;
                Ok(value)
            }
            None => anyhow::bail!("database key is missing for profile {profile_id}"),
        }
    }

    fn create_profile_inner(&self, name: &str) -> anyhow::Result<ProfileItem> {
        let name = name.trim();
        anyhow::ensure!(
            !name.is_empty() && name.chars().count() <= 80,
            "档案名称必须包含1到80个字符"
        );
        anyhow::ensure!(
            !name.chars().any(char::is_control),
            "档案名称不能包含控制字符"
        );
        let id = format!("profile-{}", Uuid::new_v4());
        let key = self.database_key(&id, true)?;
        let database = Arc::new(EncryptedDatabase::open(
            &self.profiles_directory.join(format!("{id}.db")),
            &hex::encode(key),
        )?);
        initialize_empty_profile(&database, &id, name)?;
        anyhow::ensure!(
            self.catalog.add(&id, name)?,
            "generated profile id already exists"
        );
        self.profiles
            .write()
            .map_err(|_| anyhow::anyhow!("profile lock poisoned"))?
            .insert(
                id.clone(),
                ProfileHandle {
                    name: name.into(),
                    database,
                },
            );
        Ok(ProfileItem {
            id,
            name: name.into(),
        })
    }

    fn export_profile_inner(
        &self,
        profile_id: &str,
        password: &str,
        destination: &std::path::Path,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(!password.is_empty(), "备份口令不能为空");
        anyhow::ensure!(!destination.exists(), "备份目标已存在，不会覆盖");
        let (profile, database) = self.profile(profile_id).map_err(anyhow::Error::msg)?;
        let portable = Zeroizing::new(database.export_portable_bytes()?);
        let backup = create_profile_backup(
            &profile.id,
            &profile.name,
            &portable,
            password,
            SCHEMA_VERSION as u32,
            env!("CARGO_PKG_VERSION"),
        )?;
        let parent = destination
            .parent()
            .ok_or_else(|| anyhow::anyhow!("备份路径缺少父目录"))?;
        anyhow::ensure!(parent.is_dir(), "备份目录不存在");
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        use std::io::Write;
        temporary.write_all(&backup)?;
        temporary.as_file().sync_all()?;
        temporary.persist_noclobber(destination)?;
        Ok(())
    }

    fn import_profile_inner(
        &self,
        source: &std::path::Path,
        password: &str,
    ) -> anyhow::Result<ProfileItem> {
        anyhow::ensure!(!password.is_empty(), "备份口令不能为空");
        let backup = std::fs::read(source)?;
        let fingerprint = hex::encode(Sha256::digest(&backup));
        if let Some(profile_id) = self.catalog.imported_profile(&fingerprint)? {
            return self
                .profile(&profile_id)
                .map(|(profile, _)| profile)
                .map_err(anyhow::Error::msg);
        }
        let (_, payload, portable) =
            decode_profile_backup(&backup, password, SCHEMA_VERSION as u32)?;
        let portable = Zeroizing::new(portable);
        let id = format!("profile-{}", Uuid::new_v4());
        let name = if payload.profile_name.trim().is_empty() {
            format!("导入档案 {}", payload.profile_id)
        } else {
            payload.profile_name.trim().to_string()
        };
        let key = self.database_key(&id, true)?;
        let target = self.profiles_directory.join(format!("{id}.db"));
        let result = (|| -> anyhow::Result<Arc<EncryptedDatabase>> {
            let database =
                EncryptedDatabase::restore_portable_bytes(&target, &hex::encode(&key), &portable)?;
            database.rebind_profile(&payload.profile_id, &id, &name)?;
            anyhow::ensure!(
                self.catalog
                    .add_imported_profile(&fingerprint, &id, &name)?,
                "该备份已被其他导入操作处理"
            );
            Ok(Arc::new(database))
        })();
        let database = match result {
            Ok(database) => database,
            Err(error) => {
                let _ = self
                    .secret_store
                    .delete(&Self::secret_name(&id, "database-key"));
                if target.exists() {
                    let _ = std::fs::remove_file(&target);
                }
                return Err(error);
            }
        };
        self.profiles
            .write()
            .map_err(|_| anyhow::anyhow!("profile lock poisoned"))?
            .insert(
                id.clone(),
                ProfileHandle {
                    name: name.clone(),
                    database,
                },
            );
        Ok(ProfileItem { id, name })
    }
}

fn xiaomi_overview(profile: &ProfileItem, quantity: &str, cash: &str) -> Value {
    let owner_fixture = profile.id == "profile-xiaomi-real";
    let mut overview = json!({
      "profileId": "profile-xiaomi-real", "profileName": "我的投资档案",
      "instrumentId": "HKEX:1810", "symbol": "1810.HK", "instrumentName": "小米集团-W",
      "initialQuantity": "225600", "currentQuantity": quantity,
      "cash": { "amount": cash, "currency": "HKD" }, "cashVerification": "inferred",
      "researchStatus": "review", "unknownCount": 4,
      "transaction": {
        "id":"txn-xiaomi-20260814-12000", "executionKey":"fixture:HKEX:1810:2026-08-14:sell:12000:25.62",
        "instrumentId":"HKEX:1810", "side":"sell", "tradedAt":"2026-08-14", "quantity":"12000",
        "price":{"amount":"25.62","currency":"HKD"}, "grossAmount":{"amount":"307440","currency":"HKD"},
        "fees":{"stampDuty":{"amount":"270","currency":"HKD"},"clearingFee":{"amount":"22","currency":"HKD"},"transferFee":{"amount":"11","currency":"HKD"},"commission":{"amount":"26","currency":"HKD"},"total":{"amount":"329","currency":"HKD"}},
        "netCashFlow":{"amount":"307111","currency":"HKD"}
      },
      "valuation":{"bear":{"amount":"—","currency":"HKD"},"base":{"amount":"—","currency":"HKD"},"bull":{"amount":"—","currency":"HKD"},"baseIrr":"待更新","reverseDcf":"待更新","confidence":"low","validThrough":"待发布首版估值"},
      "liLu":[
        {"id":"moat","label":"护城河","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"incremental-roic","label":"增量资本回报","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"cash-conversion","label":"现金流转化","score":null,"trend":"unknown","evidenceFreshness":"aging"},
        {"id":"capital-allocation","label":"管理层与资本配置","score":null,"trend":"unknown","evidenceFreshness":"aging"},
        {"id":"balance-sheet","label":"资产负债表","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"runway","label":"长期跑道","score":null,"trend":"unknown","evidenceFreshness":"missing"}
      ],
      "burry":[
        {"id":"discount","label":"估值折价","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"downside","label":"下行保护","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"balance-sheet","label":"资产负债表","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"normalized-fcf","label":"正常化自由现金流","score":null,"trend":"unknown","evidenceFreshness":"aging"},
        {"id":"expectation-gap","label":"预期差","score":null,"trend":"unknown","evidenceFreshness":"missing"},
        {"id":"catalyst","label":"价值释放路径","score":null,"trend":"unknown","evidenceFreshness":"fresh"}
      ],
      "stages":[
        {"stage":1,"label":"集中度保险","cumulativeTargetQuantity":"11280","actualCumulativeQuantity":"12000","status":"completed","nextRequirement":"已由真实成交完成，禁止重复建议"},
        {"stage":2,"label":"利用反弹减仓","cumulativeTargetQuantity":"22560","actualCumulativeQuantity":"12000","status":"waiting","nextRequirement":"确认基本面未恶化、出现明显反弹并发布最新估值"},
        {"stage":3,"label":"利好兑现后减仓","cumulativeTargetQuantity":"33840","actualCumulativeQuantity":"12000","status":"blocked","nextRequirement":"Stage 2完成后复核财报、汽车数据与新车订单"},
        {"stage":4,"label":"综合风险决策","cumulativeTargetQuantity":"45120","actualCumulativeQuantity":"12000","status":"blocked","nextRequirement":"Stage 3完成后复核就业、信用、基本面与估值"}
      ]
    });
    overview["profileId"] = json!(profile.id);
    overview["profileName"] = json!(profile.name);
    if !owner_fixture {
        overview["initialQuantity"] = json!(quantity);
        overview["transaction"] = Value::Null;
        overview["unknownCount"] = json!(8);
        overview["stages"] = json!([
            {"stage":1,"label":"集中度保险","cumulativeTargetQuantity":"0","actualCumulativeQuantity":"0","status":"blocked","nextRequirement":"先录入并核验该档案的初始持仓"},
            {"stage":2,"label":"利用反弹减仓","cumulativeTargetQuantity":"0","actualCumulativeQuantity":"0","status":"blocked","nextRequirement":"Stage 1计划尚未建立"},
            {"stage":3,"label":"利好兑现后减仓","cumulativeTargetQuantity":"0","actualCumulativeQuantity":"0","status":"blocked","nextRequirement":"Stage 2计划尚未建立"},
            {"stage":4,"label":"综合风险决策","cumulativeTargetQuantity":"0","actualCumulativeQuantity":"0","status":"blocked","nextRequirement":"Stage 3计划尚未建立"}
        ]);
    }
    overview
}

fn evidence_number(score: EvidenceScore) -> Option<u8> {
    match score {
        EvidenceScore::Zero => Some(0),
        EvidenceScore::One => Some(1),
        EvidenceScore::Two => Some(2),
        EvidenceScore::Three => Some(3),
        EvidenceScore::Four => Some(4),
        EvidenceScore::Unknown => None,
    }
}

fn set_dimension_scores(target: &mut Value, scores: &[(&str, EvidenceScore)]) {
    if let Some(dimensions) = target.as_array_mut() {
        for dimension in dimensions {
            let Some(id) = dimension.get("id").and_then(Value::as_str) else {
                continue;
            };
            if let Some((_, score)) = scores.iter().find(|(candidate, _)| *candidate == id) {
                dimension["score"] = json!(evidence_number(*score));
                dimension["evidenceFreshness"] = json!(if *score == EvidenceScore::Unknown {
                    "missing"
                } else {
                    "fresh"
                });
            }
        }
    }
}

fn get_overview(state: &AppState, profile_id: Option<String>) -> Result<Value, String> {
    let profile_id = profile_id.as_deref().unwrap_or("profile-xiaomi-real");
    let (profile, database) = state.profile(profile_id)?;
    let snapshot = database
        .ledger_snapshot(profile_id, "HKEX:1810", "HKD")
        .map_err(|error| error.to_string())?;
    let mut overview = xiaomi_overview(
        &profile,
        &snapshot.quantity.to_string(),
        &snapshot.cash.to_string(),
    );
    let quote = database
        .latest_market_quote(profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    let sotp = database
        .latest_sotp(profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    let fundamentals = database
        .latest_fundamentals(profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    let assessment = database
        .latest_value_assessment(profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    let reverse_dcf = database
        .latest_reverse_dcf(profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    if let Some(valuation) = sotp.as_ref() {
        if let Some(scenarios) = valuation.scenarios() {
            overview["valuation"]["bear"]["amount"] = json!(scenarios.bear_per_share.to_string());
            overview["valuation"]["base"]["amount"] = json!(scenarios.base_per_share.to_string());
            overview["valuation"]["bull"]["amount"] = json!(scenarios.bull_per_share.to_string());
            overview["valuation"]["validThrough"] = json!(valuation.review_due.to_string());
            let confidence = valuation
                .components
                .iter()
                .chain(std::iter::once(&valuation.group_adjustment))
                .map(|component| component.confidence)
                .min_by_key(|confidence| match confidence {
                    Confidence::Low => 0,
                    Confidence::Medium => 1,
                    Confidence::High => 2,
                })
                .unwrap_or(Confidence::Low);
            overview["valuation"]["confidence"] = json!(match confidence {
                Confidence::Low => "low",
                Confidence::Medium => "medium",
                Confidence::High => "high",
            });
            if let Some(current_quote) = quote.as_ref() {
                if current_quote.is_fresh_at(Utc::now()) {
                    if let Some(irr) = expected_annualized_return(
                        current_quote.price,
                        scenarios.base_per_share,
                        Decimal::ZERO,
                        3,
                    ) {
                        overview["valuation"]["baseIrr"] = json!(format!(
                            "{}%（3年、股息0）",
                            (irr * Decimal::from(100)).round_dp(2)
                        ));
                    }
                }
            }
        }
    }
    let mut unknown_count = fundamentals
        .as_ref()
        .map(|snapshot| {
            snapshot
                .metrics
                .values()
                .filter(|value| value.is_none())
                .count()
        })
        .unwrap_or(1);
    if let Some(value) = assessment.as_ref() {
        let li_lu = [
            ("moat", value.li_lu.moat),
            ("incremental-roic", value.li_lu.incremental_roic),
            ("cash-conversion", value.li_lu.cash_conversion),
            ("capital-allocation", value.li_lu.management_and_allocation),
            ("balance-sheet", value.li_lu.balance_sheet),
            ("runway", value.li_lu.runway),
        ];
        let burry = [
            ("discount", value.burry.valuation_discount),
            ("downside", value.burry.bear_protection),
            ("balance-sheet", value.burry.balance_sheet),
            ("normalized-fcf", value.burry.normalized_fcf),
            ("expectation-gap", value.burry.expectation_gap),
            ("catalyst", value.burry.catalyst),
        ];
        unknown_count += li_lu
            .iter()
            .chain(burry.iter())
            .filter(|(_, score)| *score == EvidenceScore::Unknown)
            .count();
        set_dimension_scores(&mut overview["liLu"], &li_lu);
        set_dimension_scores(&mut overview["burry"], &burry);
        if value.gate == fin_alfred_domain::GateState::Red {
            overview["researchStatus"] = json!("blocked");
        }
    } else {
        unknown_count += 12;
    }
    if let Some(reverse) = reverse_dcf.as_ref() {
        if reverse.review_due >= Utc::now().date_naive() {
            if let Some(growth) = reverse.implied_fcf_growth() {
                overview["valuation"]["reverseDcf"] = json!(format!(
                    "隐含FCF增速 {}%（{}年）",
                    (growth * Decimal::from(100)).round_dp(2),
                    reverse.years
                ));
            }
        }
    }
    overview["unknownCount"] = json!(unknown_count);
    if fundamentals.is_some()
        && sotp.is_some()
        && assessment.is_some()
        && overview["researchStatus"] != "blocked"
    {
        overview["researchStatus"] = json!("fresh");
    }
    Ok(overview)
}

fn get_profile_activity(state: &AppState, profile_id: String) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let ledger = database
        .ledger_snapshot(&profile_id, "HKEX:1810", "HKD")
        .map_err(|error| error.to_string())?;
    let executions = database
        .execution_history(&profile_id)
        .map_err(|error| error.to_string())?;
    let decisions = database
        .decision_history(&profile_id)
        .map_err(|error| error.to_string())?;
    let audits = database
        .audit_history(&profile_id)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"ledger": ledger, "executions": executions, "decisions": decisions, "audits": audits}),
    )
}

fn initialize_ledger_baseline(
    state: &AppState,
    input: LedgerBaselineInput,
) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let snapshot = database
        .initialize_ledger_baseline(
            &input.profile_id,
            "HKEX:1810",
            "HKD",
            input.quantity,
            input.cash,
        )
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"profileId": snapshot.profile_id, "instrumentId": snapshot.instrument_id, "quantity": snapshot.quantity, "cash": snapshot.cash, "currency": snapshot.currency}),
    )
}

fn record_manual_execution(state: &AppState, input: ManualExecutionInput) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    if input.quantity <= Decimal::ZERO || input.price <= Decimal::ZERO {
        return Err("成交股数和价格必须大于0".into());
    }
    let execution = Execution {
        instrument_id: "HKEX:1810".into(),
        side: input.side,
        traded_at: input.traded_at,
        quantity: input.quantity,
        price: input.price,
        fees: FeeBreakdown {
            stamp_duty: input.stamp_duty,
            clearing_fee: input.clearing_fee,
            transfer_fee: input.transfer_fee,
            commission: input.commission,
        },
        external_id: input.external_id.filter(|value| !value.trim().is_empty()),
    };
    let result = database
        .record_execution(&input.profile_id, "HKD", &execution)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"applied": result.applied, "ledger": {"profileId": result.snapshot.profile_id, "instrumentId": result.snapshot.instrument_id, "quantity": result.snapshot.quantity, "cash": result.snapshot.cash, "currency": result.snapshot.currency}, "executionKey": execution.execution_key(&input.profile_id)}),
    )
}

fn revise_execution_fees(state: &AppState, input: FeeRevisionInput) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let result = database
        .revise_execution_fees(
            &input.profile_id,
            "HKD",
            &input.execution_key,
            &FeeBreakdown {
                stamp_duty: input.stamp_duty,
                clearing_fee: input.clearing_fee,
                transfer_fee: input.transfer_fee,
                commission: input.commission,
            },
        )
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"applied": result.applied, "cash": result.snapshot.cash, "quantity": result.snapshot.quantity}),
    )
}

fn list_profiles(state: &AppState) -> Result<Vec<ProfileItem>, String> {
    state.list_profile_items()
}

fn create_profile(state: &AppState, name: String) -> Result<ProfileItem, String> {
    state
        .create_profile_inner(&name)
        .map_err(|error| error.to_string())
}

fn save_manual_quote(state: &AppState, input: ManualQuoteInput) -> Result<bool, String> {
    if input.price <= Decimal::ZERO {
        return Err("行情价格必须大于0".into());
    }
    if input.source_label.trim().is_empty() {
        return Err("行情来源不能为空".into());
    }
    let (_, database) = state.profile(&input.profile_id)?;
    database
        .store_market_quote(&MarketQuoteSnapshot {
            profile_id: input.profile_id,
            instrument_id: "HKEX:1810".into(),
            price: input.price,
            currency: "HKD".into(),
            observed_at: input.observed_at,
            valid_until: input.observed_at + chrono::Duration::hours(24),
            origin: DataOrigin::Manual,
            source_label: input.source_label.trim().into(),
        })
        .map_err(|error| error.to_string())
}

fn save_sotp(
    state: &AppState,
    profile_id: String,
    snapshot: SotpValuation,
) -> Result<Value, String> {
    if snapshot.profile_id != profile_id || snapshot.instrument_id != "HKEX:1810" {
        return Err("估值快照作用域与当前档案或标的不匹配".into());
    }
    if snapshot.components.len() != 5 {
        return Err("小米SOTP必须包含五个业务分部及一个集团调整项".into());
    }
    let scenarios = snapshot
        .scenarios()
        .ok_or_else(|| "估值日期、复核日期或摊薄股数无效".to_string())?;
    let (_, database) = state.profile(&profile_id)?;
    let inserted = database
        .store_sotp(&snapshot)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"inserted": inserted, "scenarios": scenarios, "contentHash": snapshot.content_hash()}),
    )
}

fn save_fundamentals(
    state: &AppState,
    profile_id: String,
    snapshot: FundamentalSnapshot,
) -> Result<bool, String> {
    if snapshot.profile_id != profile_id || snapshot.instrument_id != "HKEX:1810" {
        return Err("基本面快照作用域与当前档案或标的不匹配".into());
    }
    if snapshot.source_label.trim().is_empty() {
        return Err("基本面来源不能为空".into());
    }
    if snapshot.period_end > snapshot.published_at || snapshot.published_at > snapshot.valid_until {
        return Err("基本面期间、发布日期或有效期顺序无效".into());
    }
    let (_, database) = state.profile(&profile_id)?;
    database
        .store_fundamentals(&snapshot)
        .map_err(|error| error.to_string())
}

fn save_value_assessment(
    state: &AppState,
    profile_id: String,
    assessment: XiaomiValueAssessment,
) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let result = assessment.evaluate();
    let inserted = database
        .store_value_assessment(&profile_id, "HKEX:1810", &assessment)
        .map_err(|error| error.to_string())?;
    Ok(json!({"inserted": inserted, "contentHash": assessment.content_hash(), "result": result}))
}

fn save_reverse_dcf(
    state: &AppState,
    profile_id: String,
    snapshot: ReverseDcfSnapshot,
) -> Result<Value, String> {
    if snapshot.profile_id != profile_id || snapshot.instrument_id != "HKEX:1810" {
        return Err("Reverse DCF作用域与当前档案或标的不匹配".into());
    }
    if snapshot.evidence_reference.trim().is_empty() {
        return Err("Reverse DCF证据引用不能为空".into());
    }
    let implied = snapshot
        .implied_fcf_growth()
        .ok_or_else(|| "Reverse DCF输入无效或隐含增长率超出可求解范围".to_string())?;
    let (_, database) = state.profile(&profile_id)?;
    let inserted = database
        .store_reverse_dcf(&snapshot)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"inserted": inserted, "contentHash": snapshot.content_hash(), "impliedFcfGrowth": implied.to_string()}),
    )
}

fn save_strategy_draft(
    state: &AppState,
    profile_id: String,
    draft: StrategyDraft,
) -> Result<bool, String> {
    let (_, database) = state.profile(&profile_id)?;
    database
        .save_strategy_draft(&profile_id, &draft)
        .map_err(|error| error.to_string())
}

fn validate_strategy(
    state: &AppState,
    profile_id: String,
    strategy_id: String,
    version: String,
) -> Result<StrategyDraft, String> {
    let (_, database) = state.profile(&profile_id)?;
    database
        .validate_strategy(&profile_id, &strategy_id, &version)
        .map_err(|error| error.to_string())
}

fn publish_strategy(
    state: &AppState,
    profile_id: String,
    strategy_id: String,
    version: String,
) -> Result<StrategyDraft, String> {
    let (_, database) = state.profile(&profile_id)?;
    database
        .publish_strategy(&profile_id, &strategy_id, &version)
        .map_err(|error| error.to_string())
}

fn list_strategies(state: &AppState, profile_id: String) -> Result<Vec<StrategyDraft>, String> {
    let (_, database) = state.profile(&profile_id)?;
    database
        .strategy_history(&profile_id)
        .map_err(|error| error.to_string())
}

fn evaluate_cash_deployment(guard: CashDeploymentGuard) -> Value {
    let checks = [
        (guard.red_line_clear, "red_line_clear"),
        (guard.evidence_complete, "evidence_complete"),
        (guard.valuation_current, "valuation_current"),
        (
            guard.expected_irr >= Decimal::new(15, 2),
            "expected_irr_at_least_15_percent",
        ),
        (
            guard.bear_downside <= Decimal::new(25, 2),
            "bear_downside_at_most_25_percent",
        ),
        (guard.balance_sheet_safe, "balance_sheet_safe"),
        (guard.liquidity_reserve_met, "liquidity_reserve_met"),
        (
            guard.resulting_single_name_weight <= Decimal::new(80, 2),
            "single_name_hard_cap_80_percent",
        ),
    ];
    let failed: Vec<&str> = checks
        .into_iter()
        .filter_map(|(passed, reason)| (!passed).then_some(reason))
        .collect();
    json!({"canDeploy": guard.can_deploy(), "failedChecks": failed, "advisoryOnly": true})
}

fn evaluate_xiaomi_decision_inner(
    state: &AppState,
    input: XiaomiDecisionInput,
) -> Result<Value, String> {
    if input.profile_id != "profile-xiaomi-real" {
        return Err("该档案尚未发布小米四阶段正式策略".into());
    }
    let (_, database) = state.profile(&input.profile_id)?;
    let ledger = database
        .ledger_snapshot(&input.profile_id, "HKEX:1810", "HKD")
        .map_err(|error| error.to_string())?;
    let plan = StagedPositionTransition::xiaomi(
        Decimal::from(225_600),
        Decimal::from(225_600) - ledger.quantity,
    );
    let mut effective_signals = input.signals.clone();
    let mut facts = BTreeMap::new();
    facts.insert("instrument_id".into(), "HKEX:1810".into());
    facts.insert("quantity".into(), ledger.quantity.to_string());
    facts.insert("cash".into(), ledger.cash.to_string());
    facts.insert(
        "signals".into(),
        serde_json::to_string(&input.signals).map_err(|error| error.to_string())?,
    );
    if let Some(quote) = database
        .latest_market_quote(&input.profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?
    {
        let fresh = quote.is_fresh_at(Utc::now());
        facts.insert("quote_hash".into(), quote.content_hash());
        facts.insert("quote_fresh".into(), fresh.to_string());
        effective_signals.valuation_current &= fresh;
    } else {
        facts.insert("quote_hash".into(), "missing".into());
        facts.insert("quote_fresh".into(), "false".into());
        effective_signals.valuation_current = false;
    }
    if let Some(fundamentals) = database
        .latest_fundamentals(&input.profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?
    {
        let current = fundamentals.published_at <= Utc::now().date_naive()
            && fundamentals.valid_until >= Utc::now().date_naive()
            && !fundamentals.has_unknowns();
        facts.insert("fundamentals_hash".into(), fundamentals.content_hash());
        facts.insert("fundamentals_current".into(), current.to_string());
        effective_signals.fundamentals_deteriorated |= !current;
    } else {
        facts.insert("fundamentals_hash".into(), "missing".into());
        facts.insert("fundamentals_current".into(), "false".into());
        effective_signals.fundamentals_deteriorated = true;
    }
    if let Some(sotp) = database
        .latest_sotp(&input.profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?
    {
        let current = sotp.review_due >= Utc::now().date_naive() && sotp.scenarios().is_some();
        facts.insert("sotp_hash".into(), sotp.content_hash());
        facts.insert("sotp_current".into(), current.to_string());
        effective_signals.valuation_current &= current;
    } else {
        facts.insert("sotp_hash".into(), "missing".into());
        facts.insert("sotp_current".into(), "false".into());
        effective_signals.valuation_current = false;
    }
    if let Some(reverse) = database
        .latest_reverse_dcf(&input.profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?
    {
        let current =
            reverse.review_due >= Utc::now().date_naive() && reverse.implied_fcf_growth().is_some();
        facts.insert("reverse_dcf_hash".into(), reverse.content_hash());
        facts.insert("reverse_dcf_current".into(), current.to_string());
        effective_signals.valuation_current &= current;
    } else {
        facts.insert("reverse_dcf_hash".into(), "missing".into());
        facts.insert("reverse_dcf_current".into(), "false".into());
        effective_signals.valuation_current = false;
    }
    facts.insert(
        "effective_signals".into(),
        serde_json::to_string(&effective_signals).map_err(|error| error.to_string())?,
    );
    let outcome = plan.evaluate(&effective_signals);
    let recommendation = if let StrategyOutcome::ProposeSell {
        stage,
        quantity,
        reason_code,
    } = &outcome
    {
        facts.insert("stage".into(), stage.to_string());
        facts.insert("recommended_quantity".into(), quantity.to_string());
        facts.insert("reason_code".into(), reason_code.clone());
        let snapshot = DecisionSnapshot {
            profile_id: input.profile_id.clone(),
            strategy_version: "xiaomi-four-stage-v1".into(),
            engine_version: "fin-alfred-engine-v1".into(),
            facts,
        };
        let recommendation = if let Some(existing) = database
            .find_by_decision_key(&snapshot.decision_key())
            .map_err(|error| error.to_string())?
        {
            existing
        } else {
            let created = Recommendation::proposed(snapshot, *quantity);
            database
                .insert_superseding_open(&created)
                .map_err(|error| error.to_string())?;
            created
        };
        Some(recommendation)
    } else {
        database
            .expire_open_decisions_for_profile(&input.profile_id)
            .map_err(|error| error.to_string())?;
        None
    };
    Ok(json!({"outcome": outcome, "recommendation": recommendation}))
}

fn evaluate_xiaomi_decision(state: &AppState, input: XiaomiDecisionInput) -> Result<Value, String> {
    evaluate_xiaomi_decision_inner(state, input)
}

fn accept_decision(
    state: &AppState,
    profile_id: String,
    decision_key: String,
) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let item = database
        .find_by_decision_key(&decision_key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "建议不存在".to_string())?;
    if item.snapshot.profile_id != profile_id {
        return Err("建议不属于当前档案".into());
    }
    database
        .accept_decision(&decision_key)
        .map(|item| json!(item))
        .map_err(|error| error.to_string())
}

fn reject_decision(
    state: &AppState,
    profile_id: String,
    decision_key: String,
    reason: String,
) -> Result<Value, String> {
    if reason.trim().is_empty() {
        return Err("拒绝原因不能为空".into());
    }
    let (_, database) = state.profile(&profile_id)?;
    let item = database
        .find_by_decision_key(&decision_key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "建议不存在".to_string())?;
    if item.snapshot.profile_id != profile_id {
        return Err("建议不属于当前档案".into());
    }
    database
        .reject_decision(&decision_key, reason.trim())
        .map(|item| json!(item))
        .map_err(|error| error.to_string())
}

fn replay_decision(
    state: &AppState,
    profile_id: String,
    decision_key: String,
) -> Result<bool, String> {
    let (_, database) = state.profile(&profile_id)?;
    let item = database
        .find_by_decision_key(&decision_key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "建议不存在".to_string())?;
    if item.snapshot.profile_id != profile_id {
        return Err("建议不属于当前档案".into());
    }
    database
        .replay_decision(&decision_key)
        .map_err(|error| error.to_string())
}

fn record_decision_execution(
    state: &AppState,
    input: DecisionExecutionInput,
) -> Result<Value, String> {
    if input.quantity <= Decimal::ZERO || input.price <= Decimal::ZERO {
        return Err("成交数量和价格必须大于0".into());
    }
    for fee in [
        input.stamp_duty,
        input.clearing_fee,
        input.transfer_fee,
        input.commission,
    ] {
        if fee < Decimal::ZERO {
            return Err("成交费用不能为负数".into());
        }
    }
    let (_, database) = state.profile(&input.profile_id)?;
    let recommendation = database
        .find_by_decision_key(&input.decision_key)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "建议不存在".to_string())?;
    if recommendation.snapshot.profile_id != input.profile_id {
        return Err("建议不属于当前档案".into());
    }
    if input.quantity > recommendation.target_quantity - recommendation.filled_quantity {
        return Err("成交数量超过建议剩余数量；请重新评估并生成新建议".into());
    }
    let execution = Execution {
        instrument_id: "HKEX:1810".into(),
        side: Side::Sell,
        traded_at: input.traded_at,
        quantity: input.quantity,
        price: input.price,
        fees: FeeBreakdown {
            stamp_duty: input.stamp_duty,
            clearing_fee: input.clearing_fee,
            transfer_fee: input.transfer_fee,
            commission: input.commission,
        },
        external_id: input.external_id.filter(|value| !value.trim().is_empty()),
    };
    let (recorded, recommendation) = database
        .record_execution_for_decision(&input.profile_id, "HKD", &input.decision_key, &execution)
        .map_err(|error| error.to_string())?;
    Ok(
        json!({"applied": recorded.applied, "ledger": recorded.snapshot, "recommendation": recommendation, "executionKey": execution.execution_key(&input.profile_id)}),
    )
}

fn export_profile_backup(
    state: &AppState,
    profile_id: String,
    password: String,
    destination: String,
) -> Result<(), String> {
    let password = Zeroizing::new(password);
    state
        .export_profile_inner(&profile_id, &password, std::path::Path::new(&destination))
        .map_err(|error| error.to_string())
}

fn import_profile_backup(
    state: &AppState,
    password: String,
    source: String,
) -> Result<ProfileItem, String> {
    let password = Zeroizing::new(password);
    state
        .import_profile_inner(std::path::Path::new(&source), &password)
        .map_err(|error| error.to_string())
}

fn configure_llm(
    state: &AppState,
    profile_id: String,
    config: ProviderConfig,
    api_key: String,
) -> Result<(), String> {
    let api_key = Zeroizing::new(api_key);
    OpenAiResponsesProvider::new(config.clone(), api_key.to_string())
        .map_err(|error| error.to_string())?;
    let (_, database) = state.profile(&profile_id)?;
    let secret_name = AppState::secret_name(&profile_id, "llm.provider-api-key");
    state
        .secret_store
        .put(&secret_name, api_key.as_bytes())
        .map_err(|error| error.to_string())?;
    if let Err(error) = database.put_setting(LLM_CONFIG_KEY, &config) {
        let _ = state.secret_store.delete(&secret_name);
        return Err(error.to_string());
    }
    Ok(())
}

fn default_provider_config() -> ProviderConfig {
    ProviderConfig {
        base_url: "https://api.openai.com/".into(),
        model: "gpt-5-mini".into(),
        capabilities: ProviderCapabilities {
            responses_api: true,
            structured_outputs: false,
            streaming: false,
            tools_enabled: false,
        },
    }
}

fn get_llm_configuration(state: &AppState, profile_id: String) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let stored = database
        .get_setting::<ProviderConfig>(LLM_CONFIG_KEY)
        .map_err(|error| error.to_string())?;
    let configured = stored.is_some()
        && state
            .secret_store
            .get(&AppState::secret_name(&profile_id, "llm.provider-api-key"))
            .map_err(|error| error.to_string())?
            .is_some();
    let config = stored.unwrap_or_else(default_provider_config);
    Ok(json!({"configured": configured, "baseUrl": config.base_url, "model": config.model}))
}

fn configure_market_provider(
    state: &AppState,
    profile_id: String,
    config: MarketProviderConfig,
    api_key: String,
) -> Result<(), String> {
    JsonHttpMarketDataProvider::new(config.clone()).map_err(|error| error.to_string())?;
    let (_, database) = state.profile(&profile_id)?;
    let secret_name = AppState::secret_name(&profile_id, "market.provider-api-key");
    let api_key = Zeroizing::new(api_key);
    if api_key.is_empty() {
        state
            .secret_store
            .delete(&secret_name)
            .map_err(|error| error.to_string())?;
    } else {
        state
            .secret_store
            .put(&secret_name, api_key.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    database
        .put_setting(MARKET_CONFIG_KEY, &config)
        .map_err(|error| error.to_string())
}

fn get_market_provider_configuration(
    state: &AppState,
    profile_id: String,
) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let config = database
        .get_setting::<MarketProviderConfig>(MARKET_CONFIG_KEY)
        .map_err(|error| error.to_string())?;
    let api_key_stored = state
        .secret_store
        .get(&AppState::secret_name(
            &profile_id,
            "market.provider-api-key",
        ))
        .map_err(|error| error.to_string())?
        .is_some();
    Ok(match config {
        Some(config) => {
            json!({"configured": true, "quoteUrl": config.quote_url, "sourceLabel": config.source_label, "apiKeyStored": api_key_stored})
        }
        None => {
            json!({"configured": false, "quoteUrl": "", "sourceLabel": "", "apiKeyStored": false})
        }
    })
}

fn refresh_market_quote(state: &AppState, profile_id: String) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let config = database
        .get_setting::<MarketProviderConfig>(MARKET_CONFIG_KEY)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "尚未配置在线行情提供器；请使用人工行情兜底".to_string())?;
    let provider = JsonHttpMarketDataProvider::new(config).map_err(|error| error.to_string())?;
    let secret = state
        .secret_store
        .get(&AppState::secret_name(
            &profile_id,
            "market.provider-api-key",
        ))
        .map_err(|error| error.to_string())?;
    let api_key = secret
        .map(String::from_utf8)
        .transpose()
        .map_err(|_| "行情密钥编码无效".to_string())?
        .map(Zeroizing::new);
    let snapshot = quote_snapshot(&provider, api_key, &profile_id, "HKEX:1810")
        .map_err(|error| error.to_string())?;
    let inserted = database
        .store_market_quote(&snapshot)
        .map_err(|error| error.to_string())?;
    Ok(json!({"inserted": inserted, "snapshot": snapshot, "contentHash": snapshot.content_hash()}))
}

fn agent_request(database: &EncryptedDatabase, input: &AgentInput) -> Result<AgentRequest, String> {
    let expected_conversation = format!(
        "conversation:{}:{}",
        input.context.profile_id, input.context.instrument_id
    );
    if input.conversation_id != expected_conversation {
        return Err("会话作用域与当前档案或标的不匹配".into());
    }
    let snapshot = database
        .ledger_snapshot(
            &input.context.profile_id,
            &input.context.instrument_id,
            "HKD",
        )
        .map_err(|error| error.to_string())?;
    let owner_fixture = input.context.profile_id == "profile-xiaomi-real";
    Ok(AgentRequest {
        prompt: input.message.clone(),
        context: json!({
            "profile_id": input.context.profile_id,
            "instrument_id": input.context.instrument_id,
            "position_quantity": snapshot.quantity.to_string(),
            "cash": {"amount": snapshot.cash.to_string(), "currency": snapshot.currency},
            "xiaomi_four_stage_plan": if owner_fixture { json!({
                "stage_1": {"status": "completed", "actual_cumulative_quantity": "12000", "must_not_repeat": true},
                "stage_2": {"status": "waiting", "cumulative_target_quantity": "22560"}
            }) } else { Value::Null }
        }),
        manifest: ContextManifest {
            profile_id: input.context.profile_id.clone(),
            instrument_id: Some(input.context.instrument_id.clone()),
            included_sections: vec!["ledger_summary".into(), "strategy_stage_progress".into()],
            explicitly_excluded: vec![
                "api_keys".into(),
                "backup_passwords".into(),
                "other_profiles".into(),
                "trade_permissions".into(),
            ],
        },
    })
}

fn preview_agent_message(state: &AppState, input: AgentInput) -> Result<Value, String> {
    let (_, database) = state.profile(&input.context.profile_id)?;
    let config = database
        .get_setting::<ProviderConfig>(LLM_CONFIG_KEY)
        .map_err(|error| error.to_string())?
        .unwrap_or_else(default_provider_config);
    let provider = OpenAiResponsesProvider::new(config, "preview-only-placeholder".into())
        .map_err(|error| error.to_string())?;
    let preview = provider
        .preview(&agent_request(&database, &input)?)
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "destination": preview.destination,
        "model": preview.model,
        "profileId": preview.manifest.profile_id,
        "instrumentId": preview.manifest.instrument_id,
        "fields": preview.manifest.included_sections,
        "excluded": preview.manifest.explicitly_excluded,
        "serializedBytes": preview.serialized_bytes
    }))
}

fn send_agent_message(state: &AppState, input: AgentInput) -> Result<Value, String> {
    send_agent_message_inner(state, input)
}

const PROTOTYPE_WORKSPACE_KEY: &str = "prototype.workspace-v1";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrototypeWorkspace {
    #[serde(default)]
    instruments: Vec<InstrumentProfile>,
    #[serde(default)]
    watchlist: Vec<String>,
    #[serde(default)]
    financials: Vec<AnnualFinancials>,
    #[serde(default)]
    dcf_models: Vec<DcfResult>,
    #[serde(default)]
    relative_models: Vec<RelativeResult>,
    #[serde(default)]
    external_snapshots: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileInstrumentArgs {
    profile_id: String,
    instrument_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveInstrumentArgs {
    profile_id: String,
    instrument: InstrumentProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFinancialArgs {
    profile_id: String,
    financials: AnnualFinancials,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveDcfArgs {
    profile_id: String,
    input: DcfInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveRelativeArgs {
    profile_id: String,
    input: RelativeInput,
}

fn default_workspace(profile_id: &str) -> PrototypeWorkspace {
    if profile_id != "profile-xiaomi-real" {
        return PrototypeWorkspace::default();
    }
    PrototypeWorkspace {
        instruments: vec![InstrumentProfile {
            instrument_id: "HKEX:1810".into(),
            symbol: "01810".into(),
            name: "小米集团-W".into(),
            currency: "HKD".into(),
            announcement_url: "https://www1.hkexnews.hk/search/titlesearch.xhtml?category=0&lang=ZH&market=SEHK&stockId=1000195151".into(),
            investor_relations_url: "https://ir.mi.com/".into(),
            buy_price: None,
            price_snapshots: vec![],
            manual_price_override: None,
        }],
        watchlist: vec!["HKEX:1810".into()],
        ..PrototypeWorkspace::default()
    }
}

fn load_workspace(
    database: &EncryptedDatabase,
    profile_id: &str,
) -> Result<PrototypeWorkspace, String> {
    database
        .get_setting(PROTOTYPE_WORKSPACE_KEY)
        .map_err(|error| error.to_string())
        .map(|workspace| workspace.unwrap_or_else(|| default_workspace(profile_id)))
}

fn store_workspace(
    database: &EncryptedDatabase,
    workspace: &PrototypeWorkspace,
) -> Result<(), String> {
    database
        .put_setting(PROTOTYPE_WORKSPACE_KEY, workspace)
        .map_err(|error| error.to_string())
}

fn instrument_price(instrument: &InstrumentProfile) -> Option<&PriceSnapshot> {
    instrument
        .manual_price_override
        .as_ref()
        .or_else(|| instrument.price_snapshots.last())
}

fn list_watchlist(state: &AppState, profile_id: String) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let workspace = load_workspace(&database, &profile_id)?;
    let items: Vec<Value> = workspace
        .watchlist
        .iter()
        .filter_map(|id| {
            let instrument = workspace
                .instruments
                .iter()
                .find(|item| &item.instrument_id == id)?;
            let dcf = workspace
                .dcf_models
                .iter()
                .rev()
                .find(|item| item.input.instrument_id == *id);
            let relative = workspace
                .relative_models
                .iter()
                .rev()
                .find(|item| item.input.instrument_id == *id);
            let price = instrument_price(instrument);
            let history: Vec<String> = instrument
                .price_snapshots
                .iter()
                .rev()
                .take(65)
                .map(|item| item.price.clone())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            Some(json!({
                "instrument": instrument,
                "lastPrice": price.map(|item| item.price.clone()),
                "previousClose": price.and_then(|item| item.previous_close.clone()),
                "priceSource": price.map(|item| item.source.clone()),
                "manualOverride": instrument.manual_price_override.is_some(),
                "priceHistory": history,
                "dcfBase": dcf.map(|item| item.base.value_per_share.clone()),
                "relativeBase": relative.and_then(|item| item.base.clone())
            }))
        })
        .collect();
    Ok(json!(items))
}

fn save_instrument(state: &AppState, input: SaveInstrumentArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    if input.instrument.instrument_id.trim().is_empty()
        || input.instrument.symbol.trim().is_empty()
        || input.instrument.name.trim().is_empty()
    {
        return Err("instrument id, symbol and name are required".into());
    }
    if !input.instrument.announcement_url.is_empty()
        && !input.instrument.announcement_url.starts_with("https://")
    {
        return Err("announcement URL must use HTTPS".into());
    }
    if !input.instrument.investor_relations_url.is_empty()
        && !input
            .instrument
            .investor_relations_url
            .starts_with("https://")
    {
        return Err("investor relations URL must use HTTPS".into());
    }
    match workspace
        .instruments
        .iter_mut()
        .find(|item| item.instrument_id == input.instrument.instrument_id)
    {
        Some(existing) => {
            let prices = existing.price_snapshots.clone();
            *existing = input.instrument.clone();
            existing.price_snapshots = prices;
        }
        None => workspace.instruments.push(input.instrument.clone()),
    }
    if !workspace
        .watchlist
        .contains(&input.instrument.instrument_id)
    {
        workspace
            .watchlist
            .push(input.instrument.instrument_id.clone());
    }
    store_workspace(&database, &workspace)?;
    Ok(json!(input.instrument))
}

fn remove_watchlist_instrument(
    state: &AppState,
    input: ProfileInstrumentArgs,
) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    let before = workspace.watchlist.len();
    workspace.watchlist.retain(|id| id != &input.instrument_id);
    store_workspace(&database, &workspace)?;
    Ok(json!({"removed": workspace.watchlist.len() != before}))
}

fn get_instrument_summary(state: &AppState, input: ProfileInstrumentArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let workspace = load_workspace(&database, &input.profile_id)?;
    let instrument = workspace
        .instruments
        .iter()
        .find(|item| item.instrument_id == input.instrument_id)
        .ok_or("instrument is not in this profile")?;
    let financials: Vec<_> = workspace
        .financials
        .iter()
        .filter(|item| item.instrument_id == input.instrument_id)
        .cloned()
        .collect();
    let dcf = workspace
        .dcf_models
        .iter()
        .rev()
        .find(|item| item.input.instrument_id == input.instrument_id);
    let relative = workspace
        .relative_models
        .iter()
        .rev()
        .find(|item| item.input.instrument_id == input.instrument_id);
    let ledger = database
        .ledger_snapshot(
            &input.profile_id,
            &input.instrument_id,
            &instrument.currency,
        )
        .ok();
    Ok(json!({
        "instrument": instrument,
        "price": instrument_price(instrument),
        "financials": financials,
        "dcf": dcf,
        "relative": relative,
        "ledger": ledger,
        "stageOneCompleted": input.profile_id == "profile-xiaomi-real" && input.instrument_id == "HKEX:1810"
    }))
}

fn list_annual_financials(state: &AppState, input: ProfileInstrumentArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut items: Vec<_> = load_workspace(&database, &input.profile_id)?
        .financials
        .into_iter()
        .filter(|item| item.instrument_id == input.instrument_id)
        .collect();
    items.sort_by_key(|item| item.year);
    Ok(json!(items))
}

fn save_annual_financials(state: &AppState, input: SaveFinancialArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    if !(1900..=2200).contains(&input.financials.year) {
        return Err("financial year is invalid".into());
    }
    let key = (&input.financials.instrument_id, input.financials.year);
    if let Some(existing) = workspace
        .financials
        .iter_mut()
        .find(|item| (&item.instrument_id, item.year) == key)
    {
        *existing = input.financials.clone();
    } else {
        workspace.financials.push(input.financials.clone());
    }
    store_workspace(&database, &workspace)?;
    Ok(json!(input.financials))
}

fn preview_dcf(input: SaveDcfArgs) -> Result<Value, String> {
    Ok(json!(calculate_dcf(input.input)?))
}

fn save_dcf(state: &AppState, input: SaveDcfArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    let result = calculate_dcf(input.input)?;
    let inserted = !workspace
        .dcf_models
        .iter()
        .any(|item| item.content_hash == result.content_hash);
    if inserted {
        workspace.dcf_models.push(result.clone());
        store_workspace(&database, &workspace)?;
    }
    Ok(json!({"inserted": inserted, "result": result}))
}

fn preview_relative(input: SaveRelativeArgs) -> Result<Value, String> {
    Ok(json!(calculate_relative(input.input)?))
}

fn save_relative(state: &AppState, input: SaveRelativeArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    let result = calculate_relative(input.input)?;
    let inserted = !workspace
        .relative_models
        .iter()
        .any(|item| item.content_hash == result.content_hash);
    if inserted {
        workspace.relative_models.push(result.clone());
        store_workspace(&database, &workspace)?;
    }
    Ok(json!({"inserted": inserted, "result": result}))
}

fn run_akshare(action: &str, payload: &Value) -> Result<Value, String> {
    let project_root = std::env::var_os("FIN_ALFRED_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let adapter = project_root
        .join("data-provider")
        .join("akshare_adapter.py");
    if !adapter.is_file() {
        return Err(format!(
            "AKShare adapter is missing at {}",
            adapter.display()
        ));
    }
    let stdout = tempfile::NamedTempFile::new()
        .map_err(|error| format!("failed to create AKShare stdout buffer: {error}"))?;
    let stderr = tempfile::NamedTempFile::new()
        .map_err(|error| format!("failed to create AKShare stderr buffer: {error}"))?;
    let mut child = Command::new("uv")
        .env("UV_DEFAULT_INDEX", "https://pypi.org/simple")
        .args(["run", "--frozen", "--project"])
        .arg(project_root.join("data-provider"))
        .arg("python")
        .arg(&adapter)
        .arg(action)
        .arg(payload.to_string())
        .stdout(Stdio::from(stdout.reopen().map_err(|error| {
            format!("failed to open AKShare stdout buffer: {error}")
        })?))
        .stderr(Stdio::from(stderr.reopen().map_err(|error| {
            format!("failed to open AKShare stderr buffer: {error}")
        })?))
        .spawn()
        .map_err(|error| format!("failed to start AKShare adapter: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to monitor AKShare adapter: {error}"))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "AKShare adapter timed out after 45 seconds; cached data was retained".into(),
            );
        }
        thread::sleep(Duration::from_millis(50));
    };
    let stdout = std::fs::read(stdout.path())
        .map_err(|error| format!("failed to read AKShare response: {error}"))?;
    let stderr = std::fs::read(stderr.path())
        .map_err(|error| format!("failed to read AKShare diagnostics: {error}"))?;
    if stderr.len() > 64 * 1024 {
        return Err("AKShare diagnostics exceeded 64 KiB; cached data was retained".into());
    }
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    if stdout.len() > 8 * 1024 * 1024 {
        return Err("AKShare response exceeded 8 MiB".into());
    }
    let mut value: Value = serde_json::from_slice(&stdout)
        .map_err(|error| format!("invalid AKShare response: {error}"))?;
    let diagnostic_message = String::from_utf8_lossy(&stderr).trim().to_string();
    if !diagnostic_message.is_empty() {
        if let Some(object) = value.as_object_mut() {
            object.insert("diagnosticMessage".into(), json!(diagnostic_message));
            object.insert(
                "fallbackUsed".into(),
                json!(diagnostic_message.contains("falling back")),
            );
        }
    }
    Ok(value)
}

fn refresh_watchlist_prices(state: &AppState, profile_id: String) -> Result<Value, String> {
    let (_, database) = state.profile(&profile_id)?;
    let mut workspace = load_workspace(&database, &profile_id)?;
    let symbols: Vec<String> = workspace
        .watchlist
        .iter()
        .filter_map(|id| {
            workspace
                .instruments
                .iter()
                .find(|item| &item.instrument_id == id)
                .map(|item| item.symbol.clone())
        })
        .collect();
    let response = run_akshare("prices", &json!({"symbols": symbols}))?;
    let prices = response
        .get("prices")
        .and_then(Value::as_array)
        .ok_or("AKShare price response is missing prices")?;
    let mut updated = 0;
    for value in prices {
        let symbol = value
            .get("symbol")
            .and_then(Value::as_str)
            .ok_or("price symbol is missing")?;
        if let Some(instrument) = workspace
            .instruments
            .iter_mut()
            .find(|item| item.symbol == symbol)
        {
            let snapshots: Vec<PriceSnapshot> = serde_json::from_value(
                value
                    .get("history")
                    .cloned()
                    .unwrap_or_else(|| json!([value])),
            )
            .map_err(|error| error.to_string())?;
            for snapshot in snapshots {
                if !instrument.price_snapshots.iter().any(|existing| {
                    existing.observed_at == snapshot.observed_at
                        && existing.source == snapshot.source
                }) {
                    instrument.price_snapshots.push(snapshot);
                    updated += 1;
                }
            }
            instrument
                .price_snapshots
                .sort_by(|left, right| left.observed_at.cmp(&right.observed_at));
            if instrument.price_snapshots.len() > 260 {
                let remove = instrument.price_snapshots.len() - 260;
                instrument.price_snapshots.drain(0..remove);
            }
        }
    }
    workspace.external_snapshots.push(response.clone());
    if workspace.external_snapshots.len() > 20 {
        workspace.external_snapshots.remove(0);
    }
    store_workspace(&database, &workspace)?;
    Ok(json!({
        "updated": updated,
        "fetchedAt": response.get("fetchedAt"),
        "diagnosticMessage": response.get("diagnosticMessage"),
        "fallbackUsed": response.get("fallbackUsed").and_then(Value::as_bool).unwrap_or(false)
    }))
}

fn refresh_relative_data(state: &AppState, input: ProfileInstrumentArgs) -> Result<Value, String> {
    let (_, database) = state.profile(&input.profile_id)?;
    let mut workspace = load_workspace(&database, &input.profile_id)?;
    let instrument = workspace
        .instruments
        .iter()
        .find(|item| item.instrument_id == input.instrument_id)
        .ok_or("instrument is not in this profile")?
        .clone();
    let peers: Vec<String> = workspace
        .relative_models
        .iter()
        .rev()
        .find(|item| item.input.instrument_id == input.instrument_id)
        .map(|item| {
            item.input
                .peers
                .iter()
                .filter(|peer| peer.included)
                .map(|peer| peer.symbol.clone())
                .collect()
        })
        .unwrap_or_default();
    let response = run_akshare(
        "relative",
        &json!({"symbol": instrument.symbol, "peers": peers}),
    )?;
    let fetched_at = response
        .get("fetchedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut relative_input = workspace
        .relative_models
        .iter()
        .rev()
        .find(|item| item.input.instrument_id == input.instrument_id)
        .map(|item| item.input.clone())
        .unwrap_or(RelativeInput {
            instrument_id: input.instrument_id.clone(),
            normalized_eps: "0".into(),
            normalized_ocf_per_share: "0".into(),
            pe: empty_multiple_series(),
            pcf: empty_multiple_series(),
            peers: vec![],
            source: "AKShare / Baidu / Eastmoney".into(),
            fetched_at: None,
            as_of: Utc::now().date_naive().to_string(),
        });
    relative_input.pe =
        serde_json::from_value(response.get("pe").cloned().ok_or("PE series is missing")?)
            .map_err(|error| error.to_string())?;
    relative_input.pcf = serde_json::from_value(
        response
            .get("pcf")
            .cloned()
            .ok_or("PCF series is missing")?,
    )
    .map_err(|error| error.to_string())?;
    relative_input.peers =
        serde_json::from_value(response.get("peers").cloned().unwrap_or_else(|| json!([])))
            .map_err(|error| error.to_string())?;
    relative_input.fetched_at = fetched_at;
    workspace.external_snapshots.push(response.clone());
    workspace
        .relative_models
        .retain(|item| item.input.instrument_id != input.instrument_id);
    workspace
        .relative_models
        .push(calculate_relative(relative_input.clone())?);
    store_workspace(&database, &workspace)?;
    let mut value = json!(relative_input);
    if let Some(object) = value.as_object_mut() {
        if let Some(message) = response.get("diagnosticMessage") {
            object.insert("diagnosticMessage".into(), message.clone());
        }
        object.insert(
            "fallbackUsed".into(),
            json!(response
                .get("fallbackUsed")
                .and_then(Value::as_bool)
                .unwrap_or(false)),
        );
    }
    Ok(value)
}

fn empty_multiple_series() -> MultipleSeries {
    MultipleSeries {
        current: None,
        three_year_median: None,
        five_year_median: None,
        peer_median: None,
        valid_observations: 0,
        percentile_10: None,
        percentile_90: None,
    }
}

fn send_agent_message_inner(state: &AppState, input: AgentInput) -> Result<Value, String> {
    if !AgentPolicy::default().authorize(AgentPermission::CreateDraft) {
        return Err("代理没有创建草稿权限".into());
    }
    let (_, database) = state.profile(&input.context.profile_id)?;
    let config = database
        .get_setting::<ProviderConfig>(LLM_CONFIG_KEY)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "请先在设置中配置BYOK服务商".to_string())?;
    let key = state
        .secret_store
        .get(&AppState::secret_name(
            &input.context.profile_id,
            "llm.provider-api-key",
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "BYOK密钥不存在，请重新配置".to_string())?;
    let key = String::from_utf8(key).map_err(|_| "BYOK密钥编码无效".to_string())?;
    let request = agent_request(&database, &input)?;
    let request_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&request).map_err(|error| error.to_string())?,
    ));
    let run_id = Uuid::new_v4().to_string();
    database
        .begin_agent_run(
            &run_id,
            &input.conversation_id,
            &request.manifest.profile_id,
            request.manifest.instrument_id.as_deref(),
            &config.base_url,
            &config.model,
            &request_hash,
            &serde_json::to_value(&request.manifest).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    let provider = OpenAiResponsesProvider::new(config, key).map_err(|error| {
        let _ = database.fail_agent_run(&run_id, "PROVIDER_CONFIG");
        error.to_string()
    })?;
    let result = provider.create_draft(&request).map_err(|error| {
        let _ = database.fail_agent_run(&run_id, "PROVIDER_REQUEST");
        error.to_string()
    })?;
    let artifact_id = format!("artifact:{run_id}");
    if let Err(error) = database.complete_agent_run(
        &run_id,
        &artifact_id,
        &request.manifest.profile_id,
        &result.artifact.artifact_type,
        &result.artifact.content,
        result.usage.input_tokens,
        result.usage.output_tokens,
        result.usage.total_tokens,
    ) {
        let _ = database.fail_agent_run(&run_id, "PERSIST_DRAFT");
        return Err(error.to_string());
    }
    Ok(json!({
        "message": {"id": run_id, "role": "assistant", "content": result.artifact.content},
        "artifact": {"id": artifact_id, "kind": "research-draft", "title": "AI研究草稿", "status": "draft", "summary": "由外部模型生成；尚未验证或发布。"},
        "usage": {"inputTokens": result.usage.input_tokens, "outputTokens": result.usage.output_tokens}
    }))
}

pub struct Runtime {
    state: AppState,
}

impl Runtime {
    pub fn open(
        data_directory: PathBuf,
        secret_store: Arc<dyn SecretStore>,
        deterministic_test_keys: bool,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&data_directory)?;
        let profiles_directory = data_directory.join("profiles");
        std::fs::create_dir_all(&profiles_directory)?;
        let catalog_path = data_directory.join("profiles.catalog.db");
        let catalog_key = if deterministic_test_keys {
            Sha256::digest("fin-alfred-test-catalog-key").to_vec()
        } else {
            let secret_name = "profile-catalog.database-key";
            match secret_store.get(secret_name)? {
                Some(value) => value,
                None if catalog_path.is_file() => anyhow::bail!(
                    "加密档案目录存在，但系统凭据中的目录密钥缺失；为防止覆盖旧密钥，fin-alfred 已停止启动"
                ),
                None => {
                    let value = generate_database_key().to_vec();
                    secret_store.put(secret_name, &value)?;
                    value
                }
            }
        };
        let catalog =
            ProfileCatalog::open(&catalog_path, &hex::encode(catalog_key)).map_err(|error| {
                anyhow::anyhow!(
                    "无法解密档案目录；系统凭据与 {} 不匹配: {error}",
                    catalog_path.display()
                )
            })?;
        let owner_created = catalog.add("profile-xiaomi-real", "我的投资档案")?;
        let state = AppState {
            catalog,
            profiles: RwLock::new(HashMap::new()),
            profiles_directory,
            secret_store,
            deterministic_test_keys,
        };
        for item in state.catalog.list()? {
            let database_key =
                state.database_key(&item.id, owner_created && item.id == "profile-xiaomi-real")?;
            let profile_path = state.profiles_directory.join(format!("{}.db", item.id));
            let database = Arc::new(
                EncryptedDatabase::open(&profile_path, &hex::encode(database_key)).map_err(
                    |error| {
                        anyhow::anyhow!(
                            "无法解密投资档案 {}；系统凭据与 {} 不匹配: {error}",
                            item.id,
                            profile_path.display()
                        )
                    },
                )?,
            );
            if item.id == "profile-xiaomi-real" {
                initialize_xiaomi_profile(&database)?;
            } else {
                initialize_empty_profile(&database, &item.id, &item.name)?;
            }
            state
                .profiles
                .write()
                .map_err(|_| anyhow::anyhow!("profile lock poisoned"))?
                .insert(
                    item.id,
                    ProfileHandle {
                        name: item.name,
                        database,
                    },
                );
        }
        Ok(Self { state })
    }

    pub fn open_system() -> anyhow::Result<Self> {
        let data_directory = std::env::var_os("FIN_ALFRED_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::data_local_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("fin-alfred")
            });
        let deterministic = std::env::var_os("FIN_ALFRED_TEST_DATA_DIR").is_some();
        let data_directory = std::env::var_os("FIN_ALFRED_TEST_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(data_directory);
        let secret_store: Arc<dyn SecretStore> = if deterministic {
            Arc::new(InMemorySecretStore::default())
        } else {
            Arc::new(SystemSecretStore::new("io.finalfred.gateway"))
        };
        Self::open(data_directory, secret_store, deterministic)
    }

    pub fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        let state = &self.state;
        match command {
            "list_watchlist" => value(list_watchlist(state, arg(&args, "profileId")?)),
            "save_instrument" => value(save_instrument(state, arg(&args, "input")?)),
            "remove_watchlist_instrument" => {
                value(remove_watchlist_instrument(state, arg(&args, "input")?))
            }
            "get_instrument_summary" => value(get_instrument_summary(state, arg(&args, "input")?)),
            "list_annual_financials" => value(list_annual_financials(state, arg(&args, "input")?)),
            "save_annual_financials" => value(save_annual_financials(state, arg(&args, "input")?)),
            "preview_dcf" => preview_dcf(arg(&args, "input")?),
            "save_dcf_model" => value(save_dcf(state, arg(&args, "input")?)),
            "preview_relative_valuation" => preview_relative(arg(&args, "input")?),
            "save_relative_valuation" => value(save_relative(state, arg(&args, "input")?)),
            "refresh_watchlist_prices" => {
                value(refresh_watchlist_prices(state, arg(&args, "profileId")?))
            }
            "refresh_relative_data" => value(refresh_relative_data(state, arg(&args, "input")?)),
            "get_overview" => value(get_overview(state, optional_arg(&args, "profileId")?)),
            "get_profile_activity" => value(get_profile_activity(state, arg(&args, "profileId")?)),
            "initialize_ledger_baseline" => {
                value(initialize_ledger_baseline(state, arg(&args, "input")?))
            }
            "record_manual_execution" => {
                value(record_manual_execution(state, arg(&args, "input")?))
            }
            "revise_execution_fees" => value(revise_execution_fees(state, arg(&args, "input")?)),
            "list_profiles" => value(list_profiles(state)),
            "create_profile" => value(create_profile(state, arg(&args, "name")?)),
            "save_manual_quote" => value(save_manual_quote(state, arg(&args, "input")?)),
            "save_sotp" => value(save_sotp(
                state,
                arg(&args, "profileId")?,
                arg(&args, "snapshot")?,
            )),
            "save_fundamentals" => value(save_fundamentals(
                state,
                arg(&args, "profileId")?,
                arg(&args, "snapshot")?,
            )),
            "save_value_assessment" => value(save_value_assessment(
                state,
                arg(&args, "profileId")?,
                arg(&args, "assessment")?,
            )),
            "save_reverse_dcf" => value(save_reverse_dcf(
                state,
                arg(&args, "profileId")?,
                arg(&args, "snapshot")?,
            )),
            "save_strategy_draft" => value(save_strategy_draft(
                state,
                arg(&args, "profileId")?,
                arg(&args, "draft")?,
            )),
            "validate_strategy" => value(validate_strategy(
                state,
                arg(&args, "profileId")?,
                arg(&args, "strategyId")?,
                arg(&args, "version")?,
            )),
            "publish_strategy" => value(publish_strategy(
                state,
                arg(&args, "profileId")?,
                arg(&args, "strategyId")?,
                arg(&args, "version")?,
            )),
            "list_strategies" => value(list_strategies(state, arg(&args, "profileId")?)),
            "evaluate_cash_deployment" => Ok(evaluate_cash_deployment(arg(&args, "guard")?)),
            "evaluate_xiaomi_decision" => {
                value(evaluate_xiaomi_decision(state, arg(&args, "input")?))
            }
            "accept_decision" => value(accept_decision(
                state,
                arg(&args, "profileId")?,
                arg(&args, "decisionKey")?,
            )),
            "reject_decision" => value(reject_decision(
                state,
                arg(&args, "profileId")?,
                arg(&args, "decisionKey")?,
                arg(&args, "reason")?,
            )),
            "replay_decision" => value(replay_decision(
                state,
                arg(&args, "profileId")?,
                arg(&args, "decisionKey")?,
            )),
            "record_decision_execution" => {
                value(record_decision_execution(state, arg(&args, "input")?))
            }
            "export_profile_backup" => value(export_profile_backup(
                state,
                arg(&args, "profileId")?,
                arg(&args, "password")?,
                arg(&args, "destination")?,
            )),
            "import_profile_backup" => value(import_profile_backup(
                state,
                arg(&args, "password")?,
                arg(&args, "source")?,
            )),
            "export_profile_backup_bytes" => {
                let profile_id: String = arg(&args, "profileId")?;
                let password: String = arg(&args, "password")?;
                let bytes = self.export_profile_backup_bytes(&profile_id, &password)?;
                Ok(json!({"data":URL_SAFE_NO_PAD.encode(bytes)}))
            }
            "import_profile_backup_bytes" => {
                let encoded: String = arg(&args, "data")?;
                let password: String = arg(&args, "password")?;
                let bytes = URL_SAFE_NO_PAD
                    .decode(encoded)
                    .map_err(|_| "备份内容不是有效编码".to_string())?;
                value(self.import_profile_backup_bytes(&bytes, &password))
            }
            "configure_llm" => value(configure_llm(
                state,
                arg(&args, "profileId")?,
                arg(&args, "config")?,
                arg(&args, "apiKey")?,
            )),
            "get_llm_configuration" => {
                value(get_llm_configuration(state, arg(&args, "profileId")?))
            }
            "configure_market_provider" => value(configure_market_provider(
                state,
                arg(&args, "profileId")?,
                arg(&args, "config")?,
                arg(&args, "apiKey")?,
            )),
            "get_market_provider_configuration" => value(get_market_provider_configuration(
                state,
                arg(&args, "profileId")?,
            )),
            "refresh_market_quote" => value(refresh_market_quote(state, arg(&args, "profileId")?)),
            "preview_agent_message" => value(preview_agent_message(state, arg(&args, "input")?)),
            "send_agent_message" => value(send_agent_message(state, arg(&args, "input")?)),
            "create_mcp_token" => {
                Ok(json!({"token": self.create_mcp_token(arg(&args, "profileId")?)?}))
            }
            "get_mcp_configuration" => {
                Ok(json!({"configured": self.mcp_token_configured(arg(&args, "profileId")?)?}))
            }
            "get_legacy_migration" => self.legacy_migration_status(),
            "migrate_legacy_profiles" => self.migrate_legacy_profiles(),
            _ => Err(format!("unknown command: {command}")),
        }
    }

    pub fn create_mcp_token(&self, profile_id: String) -> Result<String, String> {
        self.state
            .profile(&profile_id)
            .map_err(|error| error.to_string())?;
        let mut bytes = [0_u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = URL_SAFE_NO_PAD.encode(bytes);
        let digest = Sha256::digest(token.as_bytes());
        let record =
            serde_json::to_vec(&json!({"profileId":profile_id,"digest":hex::encode(digest)}))
                .map_err(|error| error.to_string())?;
        self.state
            .secret_store
            .put("mcp-access-token.sha256", &record)
            .map_err(|error| error.to_string())?;
        Ok(token)
    }

    pub fn mcp_token_configured(&self, profile_id: String) -> Result<bool, String> {
        let record = self
            .state
            .secret_store
            .get("mcp-access-token.sha256")
            .map_err(|error| error.to_string())?;
        Ok(record
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value
                    .get("profileId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .is_some_and(|configured_profile| configured_profile == profile_id))
    }

    pub fn verify_mcp_token(&self, token: &str) -> Option<String> {
        let record = self
            .state
            .secret_store
            .get("mcp-access-token.sha256")
            .ok()??;
        let record: Value = serde_json::from_slice(&record).ok()?;
        let profile_id = record.get("profileId")?.as_str()?.to_owned();
        let expected = hex::decode(record.get("digest")?.as_str()?).ok()?;
        let actual = Sha256::digest(token.as_bytes());
        (expected.len() == actual.len() && expected.ct_eq(actual.as_slice()).into())
            .then_some(profile_id)
    }

    fn export_profile_backup_bytes(
        &self,
        profile_id: &str,
        password: &str,
    ) -> Result<Vec<u8>, String> {
        let directory = self
            .state
            .profiles_directory
            .parent()
            .ok_or("档案目录无效")?;
        let file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        self.state
            .export_profile_inner(profile_id, password, file.path())
            .map_err(|error| error.to_string())?;
        std::fs::read(file.path()).map_err(|error| error.to_string())
    }

    fn import_profile_backup_bytes(
        &self,
        bytes: &[u8],
        password: &str,
    ) -> Result<ProfileItem, String> {
        let directory = self
            .state
            .profiles_directory
            .parent()
            .ok_or("档案目录无效")?;
        let mut file =
            tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        self.state
            .import_profile_inner(file.path(), password)
            .map_err(|error| error.to_string())
    }

    pub fn legacy_migration_status(&self) -> Result<Value, String> {
        let Some(directory) = legacy_data_directory() else {
            return Ok(json!({"available":false,"profiles":[]}));
        };
        if !directory.join("profiles.catalog.db").is_file() {
            return Ok(json!({"available":false,"profiles":[]}));
        }
        let store = SystemSecretStore::new("io.finalfred.desktop");
        self.legacy_migration_status_from(&directory, &store)
    }

    fn legacy_migration_status_from(
        &self,
        directory: &std::path::Path,
        store: &dyn SecretStore,
    ) -> Result<Value, String> {
        let catalog_key = store
            .get("profile-catalog.database-key")
            .map_err(|error| error.to_string())?
            .ok_or("旧桌面档案目录存在，但系统密钥缺失")?;
        let catalog = ProfileCatalog::open(
            &directory.join("profiles.catalog.db"),
            &hex::encode(catalog_key),
        )
        .map_err(|error| error.to_string())?;
        let existing = self.state.list_profile_items()?;
        let mut profiles = Vec::new();
        for item in catalog.list().map_err(|error| error.to_string())? {
            let key = store
                .get(&AppState::secret_name(&item.id, "database-key"))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("旧档案 {} 的数据库密钥缺失", item.name))?;
            let database = EncryptedDatabase::open(
                &directory.join("profiles").join(format!("{}.db", item.id)),
                &hex::encode(key),
            )
            .map_err(|error| error.to_string())?;
            let portable = database
                .export_portable_bytes()
                .map_err(|error| error.to_string())?;
            let migrated_id = migrated_profile_id(&item.id, &portable);
            let ledger = database
                .ledger_snapshot(&item.id, "HKEX:1810", "HKD")
                .map_err(|error| error.to_string())?;
            profiles.push(json!({
                "sourceId":item.id,
                "name":item.name,
                "quantity":ledger.quantity.to_string(),
                "cash":ledger.cash.to_string(),
                "migrated":existing.iter().any(|profile| profile.id == migrated_id)
            }));
        }
        Ok(json!({"available":true,"directory":directory,"profiles":profiles}))
    }

    pub fn migrate_legacy_profiles(&self) -> Result<Value, String> {
        let directory = legacy_data_directory().ok_or("未找到旧桌面数据目录")?;
        let store = SystemSecretStore::new("io.finalfred.desktop");
        self.migrate_legacy_profiles_from(&directory, &store)
    }

    fn migrate_legacy_profiles_from(
        &self,
        directory: &std::path::Path,
        store: &dyn SecretStore,
    ) -> Result<Value, String> {
        let catalog_key = store
            .get("profile-catalog.database-key")
            .map_err(|error| error.to_string())?
            .ok_or("旧桌面档案密钥缺失")?;
        let old_catalog = ProfileCatalog::open(
            &directory.join("profiles.catalog.db"),
            &hex::encode(catalog_key),
        )
        .map_err(|error| error.to_string())?;
        let mut imported = Vec::new();
        for item in old_catalog.list().map_err(|error| error.to_string())? {
            let old_key = store
                .get(&AppState::secret_name(&item.id, "database-key"))
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("旧档案 {} 的数据库密钥缺失", item.name))?;
            let old_database = EncryptedDatabase::open(
                &directory.join("profiles").join(format!("{}.db", item.id)),
                &hex::encode(old_key),
            )
            .map_err(|error| error.to_string())?;
            let portable = Zeroizing::new(
                old_database
                    .export_portable_bytes()
                    .map_err(|error| error.to_string())?,
            );
            let migrated_id = migrated_profile_id(&item.id, &portable);
            if self.state.profile(&migrated_id).is_ok() {
                continue;
            }
            let new_key = self
                .state
                .database_key(&migrated_id, true)
                .map_err(|error| error.to_string())?;
            let target = self
                .state
                .profiles_directory
                .join(format!("{migrated_id}.db"));
            if target.exists() {
                std::fs::remove_file(&target).map_err(|error| error.to_string())?;
            }
            let migrated = (|| -> anyhow::Result<Arc<EncryptedDatabase>> {
                let database = EncryptedDatabase::restore_portable_bytes(
                    &target,
                    &hex::encode(new_key),
                    &portable,
                )?;
                database.rebind_profile(&item.id, &migrated_id, &item.name)?;
                anyhow::ensure!(
                    self.state.catalog.add(&migrated_id, &item.name)?,
                    "迁移档案已存在"
                );
                Ok(Arc::new(database))
            })();
            let database = match migrated {
                Ok(database) => database,
                Err(error) => {
                    let _ = self
                        .state
                        .secret_store
                        .delete(&AppState::secret_name(&migrated_id, "database-key"));
                    let _ = std::fs::remove_file(&target);
                    return Err(error.to_string());
                }
            };
            self.state
                .profiles
                .write()
                .map_err(|_| "档案锁不可用".to_string())?
                .insert(
                    migrated_id.clone(),
                    ProfileHandle {
                        name: item.name.clone(),
                        database,
                    },
                );
            imported.push(json!({"id":migrated_id,"name":item.name}));
        }
        Ok(json!({"imported":imported}))
    }
}

fn legacy_data_directory() -> Option<PathBuf> {
    dirs::data_dir().map(|directory| directory.join("io.finalfred.desktop"))
}

fn migrated_profile_id(source_id: &str, portable: &[u8]) -> String {
    let digest = Sha256::digest([source_id.as_bytes(), portable].concat());
    format!("legacy-{}", &hex::encode(digest)[..24])
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args
        .get(name)
        .cloned()
        .ok_or_else(|| format!("missing argument: {name}"))?;
    serde_json::from_value(value).map_err(|error| format!("invalid argument {name}: {error}"))
}

fn optional_arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Option<T>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|error| format!("invalid argument {name}: {error}")),
    }
}

fn value<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|item| serde_json::to_value(item).map_err(|error| error.to_string()))
}

fn decimal(value: &str) -> anyhow::Result<Decimal> {
    Ok(Decimal::from_str(value)?)
}

fn initialize_xiaomi_profile(database: &EncryptedDatabase) -> anyhow::Result<()> {
    if !database.ledger_exists("profile-xiaomi-real", "HKEX:1810", "HKD")? {
        database.seed_ledger(
            &LedgerSnapshot {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
                quantity: decimal("225600")?,
                cash: decimal("87889")?,
                currency: "HKD".into(),
            },
            "我的投资档案",
        )?;
    }
    database.record_execution(
        "profile-xiaomi-real",
        "HKD",
        &Execution {
            instrument_id: "HKEX:1810".into(),
            side: Side::Sell,
            traded_at: NaiveDate::from_ymd_opt(2026, 8, 14).expect("Xiaomi fixture date is valid"),
            quantity: decimal("12000")?,
            price: decimal("25.62")?,
            fees: FeeBreakdown {
                stamp_duty: decimal("270")?,
                clearing_fee: decimal("22")?,
                transfer_fee: decimal("11")?,
                commission: decimal("26")?,
            },
            external_id: Some("user-confirmed-20260814-12000-25.62".into()),
        },
    )?;
    Ok(())
}

fn initialize_empty_profile(
    database: &EncryptedDatabase,
    profile_id: &str,
    profile_name: &str,
) -> anyhow::Result<()> {
    if !database.ledger_exists(profile_id, "HKEX:1810", "HKD")? {
        database.seed_ledger(
            &LedgerSnapshot {
                profile_id: profile_id.into(),
                instrument_id: "HKEX:1810".into(),
                quantity: Decimal::ZERO,
                cash: Decimal::ZERO,
                currency: "HKD".into(),
            },
            profile_name,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fin_alfred_domain::SotpComponent;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::{tempdir, TempDir};

    fn open_test_state(path: &std::path::Path) -> AppState {
        let profiles_directory = path.join("profiles");
        std::fs::create_dir_all(&profiles_directory).unwrap();
        let catalog = ProfileCatalog::open(
            &path.join("profiles.catalog.db"),
            &hex::encode(Sha256::digest("fin-alfred-test-catalog-key")),
        )
        .unwrap();
        catalog.add("profile-xiaomi-real", "我的投资档案").unwrap();
        let state = AppState {
            catalog,
            profiles: RwLock::new(HashMap::new()),
            profiles_directory,
            secret_store: Arc::new(InMemorySecretStore::default()),
            deterministic_test_keys: true,
        };
        for item in state.catalog.list().unwrap() {
            let key = state.database_key(&item.id, false).unwrap();
            let database = Arc::new(
                EncryptedDatabase::open(
                    &state.profiles_directory.join(format!("{}.db", item.id)),
                    &hex::encode(key),
                )
                .unwrap(),
            );
            if item.id == "profile-xiaomi-real" {
                initialize_xiaomi_profile(&database).unwrap();
            } else {
                initialize_empty_profile(&database, &item.id, &item.name).unwrap();
            }
            state.profiles.write().unwrap().insert(
                item.id,
                ProfileHandle {
                    name: item.name,
                    database,
                },
            );
        }
        state
    }

    fn test_state() -> (TempDir, AppState) {
        let directory = tempdir().unwrap();
        let state = open_test_state(directory.path());
        (directory, state)
    }

    #[test]
    fn desktop_profile_initialization_is_restart_idempotent() {
        let database = EncryptedDatabase::open_in_memory().unwrap();
        initialize_xiaomi_profile(&database).unwrap();
        initialize_xiaomi_profile(&database).unwrap();
        let snapshot = database
            .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
            .unwrap();
        assert_eq!(snapshot.quantity, decimal("213600").unwrap());
        assert_eq!(snapshot.cash, decimal("395000").unwrap());
    }

    #[test]
    fn existing_encrypted_catalog_without_system_key_is_never_overwritten() {
        let directory = tempdir().unwrap();
        let catalog_path = directory.path().join("profiles.catalog.db");
        std::fs::write(&catalog_path, b"existing-encrypted-catalog").unwrap();
        let before = std::fs::read(&catalog_path).unwrap();
        let secrets = Arc::new(InMemorySecretStore::default());

        let error = Runtime::open(directory.path().to_path_buf(), secrets.clone(), false)
            .err()
            .expect("missing key must stop startup");

        assert!(error.to_string().contains("目录密钥缺失"));
        assert_eq!(std::fs::read(&catalog_path).unwrap(), before);
        assert!(secrets
            .get("profile-catalog.database-key")
            .unwrap()
            .is_none());
    }

    #[test]
    fn watchlist_updates_are_idempotent_and_never_mutate_the_xiaomi_ledger() {
        let (_directory, state) = test_state();
        let (_, database) = state.profile("profile-xiaomi-real").unwrap();
        let before = database
            .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
            .unwrap();
        let rows = list_watchlist(&state, "profile-xiaomi-real".into()).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        let mut instrument: InstrumentProfile =
            serde_json::from_value(rows[0]["instrument"].clone()).unwrap();
        instrument.manual_price_override = Some(PriceSnapshot {
            price: "26.10".into(),
            previous_close: Some("25.40".into()),
            observed_at: "2026-08-18T12:00:00+08:00".into(),
            source: "Manual Override".into(),
        });
        let input = SaveInstrumentArgs {
            profile_id: "profile-xiaomi-real".into(),
            instrument: instrument.clone(),
        };
        save_instrument(&state, input.clone()).unwrap();
        save_instrument(&state, input).unwrap();
        let rows = list_watchlist(&state, "profile-xiaomi-real".into()).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["lastPrice"], "26.10");
        assert_eq!(rows[0]["manualOverride"], true);

        remove_watchlist_instrument(
            &state,
            ProfileInstrumentArgs {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
            },
        )
        .unwrap();
        assert!(list_watchlist(&state, "profile-xiaomi-real".into())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(get_instrument_summary(
            &state,
            ProfileInstrumentArgs {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
            },
        )
        .is_ok());

        let after = database
            .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn creating_family_profile_uses_an_independent_encrypted_database() {
        let (directory, state) = test_state();
        let family = state.create_profile_inner("家人投资档案").unwrap();
        let profiles = state.list_profile_items().unwrap();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[1], family);
        let (_, owner_database) = state.profile("profile-xiaomi-real").unwrap();
        let (_, family_database) = state.profile(&family.id).unwrap();
        let owner = owner_database
            .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
            .unwrap();
        let family_ledger = family_database
            .ledger_snapshot(&family.id, "HKEX:1810", "HKD")
            .unwrap();
        assert_eq!(owner.quantity, decimal("213600").unwrap());
        assert_eq!(owner.cash, decimal("395000").unwrap());
        assert_eq!(family_ledger.quantity, Decimal::ZERO);
        assert_eq!(family_ledger.cash, Decimal::ZERO);
        let bytes =
            std::fs::read(state.profiles_directory.join(format!("{}.db", family.id))).unwrap();
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        family_database
            .put_setting("family-only", &serde_json::json!(true))
            .unwrap();
        assert!(owner_database
            .get_setting::<bool>("family-only")
            .unwrap()
            .is_none());
        drop(family_database);
        drop(owner_database);
        drop(state);
        let restarted = open_test_state(directory.path());
        assert_eq!(restarted.list_profile_items().unwrap().len(), 2);
        let (_, owner_database) = restarted.profile("profile-xiaomi-real").unwrap();
        let (_, family_database) = restarted.profile(&family.id).unwrap();
        assert_eq!(
            owner_database
                .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
                .unwrap()
                .quantity,
            decimal("213600").unwrap()
        );
        assert_eq!(
            family_database
                .ledger_snapshot(&family.id, "HKEX:1810", "HKD")
                .unwrap()
                .quantity,
            Decimal::ZERO
        );
    }

    #[test]
    fn password_backup_import_is_reencrypted_profile_scoped_and_repeatable() {
        let (directory, state) = test_state();
        let backup_path = directory.path().join("xiaomi.fin-alfred-backup");
        state
            .export_profile_inner(
                "profile-xiaomi-real",
                "correct horse battery staple",
                &backup_path,
            )
            .unwrap();
        let before = state.list_profile_items().unwrap().len();
        assert!(state
            .import_profile_inner(&backup_path, "wrong password")
            .is_err());
        assert_eq!(state.list_profile_items().unwrap().len(), before);

        let imported = state
            .import_profile_inner(&backup_path, "correct horse battery staple")
            .unwrap();
        assert_ne!(imported.id, "profile-xiaomi-real");
        let (_, database) = state.profile(&imported.id).unwrap();
        let ledger = database
            .ledger_snapshot(&imported.id, "HKEX:1810", "HKD")
            .unwrap();
        assert_eq!(ledger.quantity, decimal("213600").unwrap());
        assert_eq!(ledger.cash, decimal("395000").unwrap());
        assert!(
            !database
                .record_execution(
                    &imported.id,
                    "HKD",
                    &Execution {
                        instrument_id: "HKEX:1810".into(),
                        side: Side::Sell,
                        traded_at: NaiveDate::from_ymd_opt(2026, 8, 14).unwrap(),
                        quantity: decimal("12000").unwrap(),
                        price: decimal("25.62").unwrap(),
                        fees: FeeBreakdown {
                            stamp_duty: decimal("270").unwrap(),
                            clearing_fee: decimal("22").unwrap(),
                            transfer_fee: decimal("11").unwrap(),
                            commission: decimal("26").unwrap(),
                        },
                        external_id: Some("user-confirmed-20260814-12000-25.62".into()),
                    }
                )
                .unwrap()
                .applied
        );
        let repeated = state
            .import_profile_inner(&backup_path, "correct horse battery staple")
            .unwrap();
        assert_eq!(repeated.id, imported.id);
        assert_eq!(state.list_profile_items().unwrap().len(), before + 1);
    }

    #[test]
    fn xiaomi_decision_creation_is_deterministic_and_supersedes_stale_open_advice() {
        let (_directory, state) = test_state();
        let (_, research_database) = state.profile("profile-xiaomi-real").unwrap();
        let observed = Utc::now();
        research_database
            .store_market_quote(&MarketQuoteSnapshot {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
                price: decimal("25.62").unwrap(),
                currency: "HKD".into(),
                observed_at: observed,
                valid_until: observed + chrono::Duration::hours(24),
                origin: DataOrigin::Manual,
                source_label: "user verified".into(),
            })
            .unwrap();
        let component = |name: &str| SotpComponent {
            name: name.into(),
            bear_value: decimal("1").unwrap(),
            base_value: decimal("2").unwrap(),
            bull_value: decimal("3").unwrap(),
            confidence: Confidence::Medium,
            evidence_reference: "manual fixture".into(),
        };
        research_database
            .store_sotp(&SotpValuation {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
                as_of: observed.date_naive(),
                review_due: observed.date_naive() + chrono::Duration::days(90),
                components: [
                    "Smartphone",
                    "IoT & Lifestyle",
                    "Internet Services",
                    "EV",
                    "AI, robotics and options",
                ]
                .into_iter()
                .map(component)
                .collect(),
                group_adjustment: component("Net cash and group adjustment"),
                diluted_shares: decimal("1").unwrap(),
            })
            .unwrap();
        research_database
            .store_fundamentals(&FundamentalSnapshot {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
                period_end: observed.date_naive() - chrono::Duration::days(30),
                published_at: observed.date_naive(),
                valid_until: observed.date_naive() + chrono::Duration::days(90),
                source_label: "filing fixture".into(),
                metrics: [
                    ("revenue".into(), Some(decimal("1").unwrap())),
                    ("free_cash_flow".into(), Some(decimal("1").unwrap())),
                    ("ev_gross_margin".into(), Some(decimal("1").unwrap())),
                ]
                .into_iter()
                .collect(),
            })
            .unwrap();
        research_database
            .store_reverse_dcf(&ReverseDcfSnapshot {
                profile_id: "profile-xiaomi-real".into(),
                instrument_id: "HKEX:1810".into(),
                as_of: observed.date_naive(),
                review_due: observed.date_naive() + chrono::Duration::days(90),
                enterprise_value: decimal("1500").unwrap(),
                starting_free_cash_flow: decimal("100").unwrap(),
                discount_rate: decimal("0.10").unwrap(),
                terminal_multiple: decimal("10").unwrap(),
                years: 5,
                evidence_reference: "reverse DCF fixture".into(),
            })
            .unwrap();
        let ready = XiaomiSignals {
            rebound_confirmed_by_user: true,
            valuation_current: true,
            ..XiaomiSignals::default()
        };
        let first = evaluate_xiaomi_decision_inner(
            &state,
            XiaomiDecisionInput {
                profile_id: "profile-xiaomi-real".into(),
                signals: ready.clone(),
            },
        )
        .unwrap();
        assert_eq!(first["outcome"]["stage"], 2);
        assert_eq!(first["outcome"]["quantity"], "10560.00");
        let first_key = first["recommendation"]["decision_key"]
            .as_str()
            .unwrap()
            .to_string();
        let repeated = evaluate_xiaomi_decision_inner(
            &state,
            XiaomiDecisionInput {
                profile_id: "profile-xiaomi-real".into(),
                signals: ready.clone(),
            },
        )
        .unwrap();
        assert_eq!(repeated["recommendation"]["decision_key"], first_key);

        let replacement = evaluate_xiaomi_decision_inner(
            &state,
            XiaomiDecisionInput {
                profile_id: "profile-xiaomi-real".into(),
                signals: XiaomiSignals {
                    fundamentals_strong: true,
                    ..ready
                },
            },
        )
        .unwrap();
        let replacement_key = replacement["recommendation"]["decision_key"]
            .as_str()
            .unwrap();
        assert_ne!(replacement_key, first_key);
        let (_, database) = state.profile("profile-xiaomi-real").unwrap();
        let stale = database.find_by_decision_key(&first_key).unwrap().unwrap();
        assert_eq!(
            stale.status,
            fin_alfred_domain::RecommendationStatus::Superseded
        );
        assert_eq!(stale.superseded_by.as_deref(), Some(replacement_key));
        assert!(database.replay_decision(replacement_key).unwrap());

        let invalidated = evaluate_xiaomi_decision_inner(
            &state,
            XiaomiDecisionInput {
                profile_id: "profile-xiaomi-real".into(),
                signals: XiaomiSignals {
                    thesis_invalidated: true,
                    ..XiaomiSignals::default()
                },
            },
        )
        .unwrap();
        assert_eq!(invalidated["outcome"]["outcome"], "exit_review");
        assert!(invalidated["recommendation"].is_null());
        let expired = database
            .find_by_decision_key(replacement_key)
            .unwrap()
            .unwrap();
        assert_eq!(
            expired.status,
            fin_alfred_domain::RecommendationStatus::Expired
        );
    }

    #[test]
    fn user_checkbox_cannot_bypass_missing_or_expired_valuation_data() {
        let (_directory, state) = test_state();
        let result = evaluate_xiaomi_decision_inner(
            &state,
            XiaomiDecisionInput {
                profile_id: "profile-xiaomi-real".into(),
                signals: XiaomiSignals {
                    rebound_confirmed_by_user: true,
                    valuation_current: true,
                    ..XiaomiSignals::default()
                },
            },
        )
        .unwrap();
        assert_eq!(result["outcome"]["outcome"], "wait");
        assert_eq!(
            result["outcome"]["missing_checks"],
            json!([
                "fundamentals_not_deteriorated",
                "current_valuation_and_quote"
            ])
        );
        assert!(result["recommendation"].is_null());
    }

    #[test]
    fn desktop_agent_flow_uses_server_ledger_and_persists_draft_audit() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            let header_end = loop {
                let read = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
                if let Some(position) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .map(str::parse)
                })
                .unwrap()
                .unwrap();
            while request.len() < header_end + content_length {
                let read = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
            }
            let wire = String::from_utf8_lossy(&request);
            assert!(wire.contains("213600"));
            assert!(wire.contains("395000"));
            assert!(wire.contains("must_not_repeat"));
            assert!(!wire.contains("\"tools\""));
            let body = r#"{"id":"resp_desktop","output":[{"content":[{"type":"output_text","text":"只读研究草稿"}]}],"usage":{"input_tokens":30,"output_tokens":5,"total_tokens":35}}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });

        let (_directory, state) = test_state();
        let (_, database) = state.profile("profile-xiaomi-real").unwrap();
        state
            .secret_store
            .put(
                &AppState::secret_name("profile-xiaomi-real", "llm.provider-api-key"),
                b"test-key",
            )
            .unwrap();
        database
            .put_setting(
                LLM_CONFIG_KEY,
                &ProviderConfig {
                    base_url: format!("http://{address}/"),
                    model: "contract-model".into(),
                    capabilities: ProviderCapabilities {
                        responses_api: true,
                        structured_outputs: false,
                        streaming: false,
                        tools_enabled: false,
                    },
                },
            )
            .unwrap();
        let response = send_agent_message_inner(
            &state,
            AgentInput {
                message: "生成检查表草稿".into(),
                conversation_id: "conversation:profile-xiaomi-real:HKEX:1810".into(),
                context: AgentInputContext {
                    profile_id: "profile-xiaomi-real".into(),
                    instrument_id: "HKEX:1810".into(),
                },
            },
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(response["artifact"]["status"], "draft");
        let run = database
            .agent_run(response["message"]["id"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(run.status, "COMPLETED");
        assert_eq!(run.input_tokens, Some(30));
        assert_eq!(run.output_tokens, Some(5));
    }

    #[test]
    fn desktop_rejects_forged_cross_profile_conversation_before_network() {
        let (_directory, state) = test_state();
        let (_, database) = state.profile("profile-xiaomi-real").unwrap();
        let error = agent_request(
            &database,
            &AgentInput {
                message: "读取另一个档案".into(),
                conversation_id: "conversation:family-profile:HKEX:1810".into(),
                context: AgentInputContext {
                    profile_id: "profile-xiaomi-real".into(),
                    instrument_id: "HKEX:1810".into(),
                },
            },
        )
        .unwrap_err();
        assert!(error.contains("作用域"));
    }

    #[test]
    fn legacy_migration_reencrypts_and_is_repeatable() {
        let old_directory = tempdir().unwrap();
        let old_store = Arc::new(InMemorySecretStore::default());
        let old =
            Runtime::open(old_directory.path().to_path_buf(), old_store.clone(), false).unwrap();
        assert_eq!(
            old.invoke("get_overview", json!({})).unwrap()["currentQuantity"],
            "213600"
        );

        let new_directory = tempdir().unwrap();
        let new_store = Arc::new(InMemorySecretStore::default());
        let migrated = Runtime::open(new_directory.path().to_path_buf(), new_store, false).unwrap();
        let preview = migrated
            .legacy_migration_status_from(old_directory.path(), old_store.as_ref())
            .unwrap();
        assert_eq!(preview["profiles"][0]["quantity"], "213600");
        let first = migrated
            .migrate_legacy_profiles_from(old_directory.path(), old_store.as_ref())
            .unwrap();
        assert_eq!(first["imported"].as_array().unwrap().len(), 1);
        let second = migrated
            .migrate_legacy_profiles_from(old_directory.path(), old_store.as_ref())
            .unwrap();
        assert!(second["imported"].as_array().unwrap().is_empty());
        assert_eq!(
            migrated
                .invoke("list_profiles", json!({}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}

use anyhow::Context;
use chrono::NaiveDate;
use margin_safety_application::RecommendationRepository;
use margin_safety_domain::{
    Execution, FundamentalSnapshot, Ledger, MarketQuoteSnapshot, Recommendation,
    RecommendationStatus, ResearchLifecycle, ReverseDcfSnapshot, Side, SotpValuation,
    StrategyDraft, XiaomiValueAssessment,
};
use rusqlite::{ffi, serialize::OwnedData, DatabaseName};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use rust_decimal::Decimal;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::ptr::NonNull;
use std::str::FromStr;
use std::sync::Mutex;

pub const SCHEMA_VERSION: i64 = 4;

pub struct EncryptedDatabase {
    connection: Mutex<Connection>,
}

pub struct ProfileCatalog {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileCatalogItem {
    pub id: String,
    pub name: String,
}

impl ProfileCatalog {
    pub fn open(path: &Path, key_hex: &str) -> anyhow::Result<Self> {
        let connection = Connection::open(path).context("open encrypted profile catalog")?;
        connection.pragma_update(None, "key", format!("x'{key_hex}'"))?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS catalog_meta(schema_version INTEGER NOT NULL);
             INSERT INTO catalog_meta(schema_version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM catalog_meta);
             CREATE TABLE IF NOT EXISTS profile_catalog(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS imported_backups(
               backup_fingerprint TEXT PRIMARY KEY,
               profile_id TEXT NOT NULL,
               imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(profile_id) REFERENCES profile_catalog(id)
             );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let connection = Connection::open_in_memory()?;
        connection.execute_batch(
            "CREATE TABLE catalog_meta(schema_version INTEGER NOT NULL);
             INSERT INTO catalog_meta(schema_version) VALUES(1);
             CREATE TABLE profile_catalog(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE imported_backups(
               backup_fingerprint TEXT PRIMARY KEY,
               profile_id TEXT NOT NULL,
               imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(profile_id) REFERENCES profile_catalog(id)
             );",
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn add(&self, id: &str, name: &str) -> anyhow::Result<bool> {
        anyhow::ensure!(!id.trim().is_empty(), "profile id is required");
        let name = name.trim();
        anyhow::ensure!(
            !name.is_empty() && name.chars().count() <= 80,
            "profile name must contain 1 to 80 characters"
        );
        anyhow::ensure!(
            !name.chars().any(char::is_control),
            "profile name cannot contain control characters"
        );
        Ok(self.connection.lock().unwrap().execute(
            "INSERT OR IGNORE INTO profile_catalog(id, name) VALUES(?1, ?2)",
            params![id, name],
        )? == 1)
    }

    pub fn list(&self) -> anyhow::Result<Vec<ProfileCatalogItem>> {
        let connection = self.connection.lock().unwrap();
        let mut statement =
            connection.prepare("SELECT id, name FROM profile_catalog ORDER BY rowid")?;
        let rows = statement.query_map([], |row| {
            Ok(ProfileCatalogItem {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn imported_profile(&self, fingerprint: &str) -> anyhow::Result<Option<String>> {
        self.connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT profile_id FROM imported_backups WHERE backup_fingerprint = ?1",
                params![fingerprint],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn register_import(&self, fingerprint: &str, profile_id: &str) -> anyhow::Result<bool> {
        Ok(self.connection.lock().unwrap().execute(
            "INSERT OR IGNORE INTO imported_backups(backup_fingerprint, profile_id) VALUES(?1, ?2)",
            params![fingerprint, profile_id],
        )? == 1)
    }

    pub fn add_imported_profile(
        &self,
        fingerprint: &str,
        id: &str,
        name: &str,
    ) -> anyhow::Result<bool> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let already_imported: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM imported_backups WHERE backup_fingerprint = ?1)",
            params![fingerprint],
            |row| row.get(0),
        )?;
        if already_imported {
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO profile_catalog(id, name) VALUES(?1, ?2)",
            params![id, name],
        )?;
        transaction.execute(
            "INSERT INTO imported_backups(backup_fingerprint, profile_id) VALUES(?1, ?2)",
            params![fingerprint, id],
        )?;
        transaction.commit()?;
        Ok(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSnapshot {
    pub profile_id: String,
    pub instrument_id: String,
    pub quantity: Decimal,
    pub cash: Decimal,
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordExecutionResult {
    pub applied: bool,
    pub snapshot: LedgerSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRunSnapshot {
    pub id: String,
    pub conversation_id: String,
    pub profile_id: String,
    pub instrument_id: Option<String>,
    pub status: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHistoryItem {
    pub execution_key: String,
    pub profile_id: String,
    pub instrument_id: String,
    pub side: String,
    pub traded_at: NaiveDate,
    pub quantity: String,
    pub price: String,
    pub gross_amount: String,
    pub net_cash_flow: String,
    pub stamp_duty: String,
    pub clearing_fee: String,
    pub transfer_fee: String,
    pub commission: String,
    pub external_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventItem {
    pub id: i64,
    pub profile_id: String,
    pub aggregate_type: String,
    pub aggregate_id: String,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

impl EncryptedDatabase {
    pub fn open(path: &Path, key_hex: &str) -> anyhow::Result<Self> {
        let connection = Connection::open(path).context("open encrypted profile database")?;
        connection.pragma_update(None, "key", format!("x'{key_hex}'"))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let db = Self {
            connection: Mutex::new(connection),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let connection = Connection::open_in_memory()?;
        let db = Self {
            connection: Mutex::new(connection),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn export_portable_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let source = self.connection.lock().unwrap();
        source.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
        source.execute_batch("ATTACH DATABASE ':memory:' AS portable KEY '';")?;
        let export_result = source.query_row("SELECT sqlcipher_export('portable')", [], |row| {
            row.get::<_, Option<String>>(0)
        });
        if let Err(error) = export_result {
            let _ = source.execute_batch("DETACH DATABASE portable;");
            return Err(error.into());
        }
        let portable = source
            .serialize(DatabaseName::Attached("portable"))?
            .as_ref()
            .to_vec();
        source.execute_batch("DETACH DATABASE portable;")?;
        Ok(portable)
    }

    pub fn restore_portable_bytes(
        target: &Path,
        key_hex: &str,
        portable: &[u8],
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(!target.exists(), "restore target already exists");
        anyhow::ensure!(!portable.is_empty(), "portable database is empty");
        anyhow::ensure!(
            key_hex.len() == 64
                && key_hex
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()),
            "database key must be 32 bytes encoded as hexadecimal"
        );

        let restore_result = (|| -> anyhow::Result<()> {
            // sqlcipher_export copies from the connection's main database into an
            // attached database. Start from the portable plaintext image so the
            // destination is encrypted directly with this device's fresh key.
            let mut plaintext = Connection::open_in_memory()?;
            let allocation = unsafe { ffi::sqlite3_malloc64(portable.len() as u64) }.cast::<u8>();
            let allocation =
                NonNull::new(allocation).context("allocate portable database buffer")?;
            unsafe {
                std::ptr::copy_nonoverlapping(
                    portable.as_ptr(),
                    allocation.as_ptr(),
                    portable.len(),
                );
                plaintext.deserialize(
                    DatabaseName::Main,
                    OwnedData::from_raw_nonnull(allocation, portable.len()),
                    true,
                )?;
            }
            plaintext.query_row("PRAGMA integrity_check", [], |row| {
                let result: String = row.get(0)?;
                if result == "ok" {
                    Ok(())
                } else {
                    Err(rusqlite::Error::InvalidQuery)
                }
            })?;
            plaintext.execute(
                &format!("ATTACH DATABASE ?1 AS encrypted KEY \"x'{key_hex}'\""),
                params![target.to_string_lossy().as_ref()],
            )?;
            let export_result =
                plaintext.query_row("SELECT sqlcipher_export('encrypted')", [], |row| {
                    row.get::<_, Option<String>>(0)
                });
            if let Err(error) = export_result {
                let _ = plaintext.execute_batch("DETACH DATABASE encrypted;");
                return Err(error.into());
            }
            plaintext.execute_batch("DETACH DATABASE encrypted;")?;
            Ok(())
        })();
        if let Err(error) = restore_result {
            // The target did not exist on entry, so only a failed restore artifact
            // can be removed here. Existing profile data is never overwritten.
            if target.exists() {
                let _ = std::fs::remove_file(target);
            }
            return Err(error);
        }

        let restored = Self::open(target, key_hex)?;
        anyhow::ensure!(
            restored.integrity_check()?,
            "restored database failed integrity check"
        );
        Ok(restored)
    }

    pub fn rebind_profile(
        &self,
        source_id: &str,
        target_id: &str,
        name: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !source_id.is_empty() && !target_id.is_empty(),
            "profile id is empty"
        );
        let mut connection = self.connection.lock().unwrap();
        connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let result = (|| -> anyhow::Result<()> {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            anyhow::ensure!(
                transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM profiles WHERE id = ?1)",
                    params![source_id],
                    |row| row.get::<_, bool>(0),
                )?,
                "source profile is missing"
            );
            let mut recommendations = {
                let mut statement =
                    transaction.prepare("SELECT payload_json FROM recommendations")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                rows.map(|payload| {
                    serde_json::from_str::<Recommendation>(&payload?).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
            };
            let decision_key_changes: HashMap<String, String> = recommendations
                .iter_mut()
                .filter(|item| item.snapshot.profile_id == source_id)
                .map(|item| {
                    let old_key = item.decision_key.clone();
                    item.snapshot.profile_id = target_id.into();
                    let new_key = item.snapshot.decision_key();
                    item.decision_key = new_key.clone();
                    (old_key, new_key)
                })
                .collect();
            for item in recommendations
                .iter_mut()
                .filter(|item| item.snapshot.profile_id == target_id)
            {
                if let Some(replacement) = item.superseded_by.as_ref() {
                    if let Some(rebound) = decision_key_changes.get(replacement) {
                        item.superseded_by = Some(rebound.clone());
                    }
                }
            }
            for item in recommendations
                .iter()
                .filter(|item| item.snapshot.profile_id == target_id)
            {
                let old_key = decision_key_changes
                    .iter()
                    .find_map(|(old, new)| (new == &item.decision_key).then_some(old))
                    .context("rebound recommendation is missing its old key")?;
                transaction.execute(
                    "UPDATE decision_fills SET decision_key = ?1 WHERE decision_key = ?2",
                    params![item.decision_key, old_key],
                )?;
                transaction.execute(
                    "UPDATE recommendations SET decision_key = ?1, status = ?2, payload_json = ?3 WHERE decision_key = ?4",
                    params![item.decision_key, recommendation_status_text(item.status), serde_json::to_string(item)?, old_key],
                )?;
                transaction.execute(
                    "UPDATE audit_events
                     SET aggregate_id = ?1, payload_json = replace(payload_json, ?2, ?1)
                     WHERE aggregate_type = 'recommendation' AND aggregate_id = ?2",
                    params![item.decision_key, old_key],
                )?;
            }
            let execution_key_changes = {
                let mut statement = transaction.prepare(
                    "SELECT execution_key, instrument_id, side, traded_at, quantity, price,
                            stamp_duty, clearing_fee, transfer_fee, commission, external_id
                     FROM executions WHERE profile_id = ?1",
                )?;
                let rows = statement.query_map(params![source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        Execution {
                            instrument_id: row.get(1)?,
                            side: if row.get::<_, String>(2)? == "sell" {
                                Side::Sell
                            } else {
                                Side::Buy
                            },
                            traded_at: row.get(3)?,
                            quantity: Decimal::from_str(&row.get::<_, String>(4)?).map_err(
                                |error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        4,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                },
                            )?,
                            price: Decimal::from_str(&row.get::<_, String>(5)?).map_err(
                                |error| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        5,
                                        rusqlite::types::Type::Text,
                                        Box::new(error),
                                    )
                                },
                            )?,
                            fees: margin_safety_domain::FeeBreakdown {
                                stamp_duty: Decimal::from_str(&row.get::<_, String>(6)?).unwrap(),
                                clearing_fee: Decimal::from_str(&row.get::<_, String>(7)?).unwrap(),
                                transfer_fee: Decimal::from_str(&row.get::<_, String>(8)?).unwrap(),
                                commission: Decimal::from_str(&row.get::<_, String>(9)?).unwrap(),
                            },
                            external_id: row.get(10)?,
                        },
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (old_key, execution) in execution_key_changes {
                let new_key = execution.execution_key(target_id);
                transaction.execute(
                    "UPDATE decision_fills SET execution_key = ?1 WHERE execution_key = ?2",
                    params![new_key, old_key],
                )?;
                transaction.execute(
                    "UPDATE executions SET execution_key = ?1 WHERE execution_key = ?2",
                    params![new_key, old_key],
                )?;
                transaction.execute(
                    "UPDATE audit_events
                     SET aggregate_id = ?1,
                         payload_json = replace(payload_json, ?2, ?1)
                     WHERE aggregate_type = 'execution' AND aggregate_id = ?2",
                    params![new_key, old_key],
                )?;
            }
            for table in [
                "cash_accounts",
                "positions",
                "executions",
                "research_snapshots",
                "conversations",
                "agent_runs",
                "agent_artifacts",
                "strategy_versions",
            ] {
                transaction.execute(
                    &format!("UPDATE {table} SET profile_id = ?1 WHERE profile_id = ?2"),
                    params![target_id, source_id],
                )?;
            }
            transaction.execute(
                "UPDATE audit_events SET profile_id = ?1 WHERE profile_id = ?2",
                params![target_id, source_id],
            )?;
            let research_changes = {
                let mut statement = transaction.prepare(
                    "SELECT id, content_hash, payload_json FROM research_snapshots WHERE profile_id = ?1",
                )?;
                let rows = statement.query_map(params![target_id], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (id, old_hash, payload) in research_changes {
                let rebound_payload = payload.replace(source_id, target_id);
                let new_hash = hex::encode(Sha256::digest(rebound_payload.as_bytes()));
                transaction.execute(
                    "UPDATE research_snapshots SET content_hash = ?1, payload_json = ?2 WHERE id = ?3",
                    params![new_hash, rebound_payload, id],
                )?;
                transaction.execute(
                    "UPDATE audit_events
                     SET aggregate_id = ?1, payload_json = replace(payload_json, ?3, ?4)
                     WHERE aggregate_type = 'research_snapshot' AND aggregate_id = ?2",
                    params![new_hash, old_hash, source_id, target_id],
                )?;
            }
            transaction.execute(
                "UPDATE agent_runs SET context_manifest_json = replace(context_manifest_json, ?2, ?1) WHERE profile_id = ?1",
                params![target_id, source_id],
            )?;
            transaction.execute(
                "UPDATE audit_events SET payload_json = replace(payload_json, ?2, ?1) WHERE profile_id = ?1",
                params![target_id, source_id],
            )?;
            transaction.execute(
                "UPDATE profiles SET id = ?1, name = ?2 WHERE id = ?3",
                params![target_id, name, source_id],
            )?;
            transaction.commit()?;
            Ok(())
        })();
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        result?;
        anyhow::ensure!(
            connection
                .query_row("PRAGMA foreign_key_check", [], |_| Ok(false))
                .optional()?
                .is_none(),
            "profile rebind failed foreign-key validation"
        );
        Ok(())
    }

    fn migrate(&self) -> anyhow::Result<()> {
        let connection = self.connection.lock().unwrap();
        connection.execute_batch(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
             INSERT INTO schema_meta(version) SELECT 4 WHERE NOT EXISTS(SELECT 1 FROM schema_meta);
             CREATE TABLE IF NOT EXISTS recommendations(
               decision_key TEXT PRIMARY KEY,
               status TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS audit_events(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               profile_id TEXT NOT NULL DEFAULT '',
               aggregate_type TEXT NOT NULL,
               aggregate_id TEXT NOT NULL,
               event_type TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS profiles(
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS instruments(
               id TEXT PRIMARY KEY,
               symbol TEXT NOT NULL,
               currency TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS cash_accounts(
               profile_id TEXT NOT NULL,
               currency TEXT NOT NULL,
               balance TEXT NOT NULL,
               verification_status TEXT NOT NULL,
               PRIMARY KEY(profile_id, currency),
               FOREIGN KEY(profile_id) REFERENCES profiles(id)
             );
             CREATE TABLE IF NOT EXISTS positions(
               profile_id TEXT NOT NULL,
               instrument_id TEXT NOT NULL,
               quantity TEXT NOT NULL,
               PRIMARY KEY(profile_id, instrument_id),
               FOREIGN KEY(profile_id) REFERENCES profiles(id),
               FOREIGN KEY(instrument_id) REFERENCES instruments(id)
             );
             CREATE TABLE IF NOT EXISTS executions(
               execution_key TEXT PRIMARY KEY,
               profile_id TEXT NOT NULL,
               instrument_id TEXT NOT NULL,
               side TEXT NOT NULL,
               traded_at TEXT NOT NULL,
               quantity TEXT NOT NULL,
               price TEXT NOT NULL,
               gross_amount TEXT NOT NULL,
               net_cash_flow TEXT NOT NULL,
               stamp_duty TEXT NOT NULL,
               clearing_fee TEXT NOT NULL,
               transfer_fee TEXT NOT NULL,
               commission TEXT NOT NULL,
               external_id TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(profile_id) REFERENCES profiles(id),
               FOREIGN KEY(instrument_id) REFERENCES instruments(id)
             );
             CREATE TABLE IF NOT EXISTS decision_fills(
               decision_key TEXT NOT NULL,
               execution_key TEXT NOT NULL,
               quantity TEXT NOT NULL,
               PRIMARY KEY(decision_key, execution_key),
               FOREIGN KEY(decision_key) REFERENCES recommendations(decision_key),
               FOREIGN KEY(execution_key) REFERENCES executions(execution_key)
             );
             CREATE TABLE IF NOT EXISTS research_snapshots(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               profile_id TEXT NOT NULL,
               instrument_id TEXT NOT NULL,
               snapshot_kind TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               UNIQUE(profile_id, snapshot_kind, content_hash),
               FOREIGN KEY(profile_id) REFERENCES profiles(id),
               FOREIGN KEY(instrument_id) REFERENCES instruments(id)
             );
             CREATE TABLE IF NOT EXISTS app_settings(
               key TEXT PRIMARY KEY,
               value_json TEXT NOT NULL,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
             );
             CREATE TABLE IF NOT EXISTS conversations(
               id TEXT PRIMARY KEY,
               profile_id TEXT NOT NULL,
               instrument_id TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(profile_id) REFERENCES profiles(id)
             );
             CREATE TABLE IF NOT EXISTS agent_runs(
               id TEXT PRIMARY KEY,
               conversation_id TEXT NOT NULL,
               profile_id TEXT NOT NULL,
               instrument_id TEXT,
               provider_base_url TEXT NOT NULL,
               model TEXT NOT NULL,
               status TEXT NOT NULL,
               request_hash TEXT NOT NULL,
               context_manifest_json TEXT NOT NULL,
               error_code TEXT,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               completed_at TEXT,
               FOREIGN KEY(conversation_id) REFERENCES conversations(id),
               FOREIGN KEY(profile_id) REFERENCES profiles(id)
             );
             CREATE TABLE IF NOT EXISTS agent_artifacts(
               id TEXT PRIMARY KEY,
               run_id TEXT NOT NULL UNIQUE,
               profile_id TEXT NOT NULL,
               artifact_type TEXT NOT NULL,
               lifecycle TEXT NOT NULL CHECK(lifecycle = 'DRAFT'),
               content TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(run_id) REFERENCES agent_runs(id),
               FOREIGN KEY(profile_id) REFERENCES profiles(id)
             );
             CREATE TABLE IF NOT EXISTS usage_records(
               run_id TEXT PRIMARY KEY,
               input_tokens INTEGER NOT NULL,
               output_tokens INTEGER NOT NULL,
               total_tokens INTEGER NOT NULL,
               FOREIGN KEY(run_id) REFERENCES agent_runs(id)
             );
             CREATE TABLE IF NOT EXISTS tool_calls(
               id TEXT PRIMARY KEY,
               run_id TEXT NOT NULL,
               tool_name TEXT NOT NULL,
               permission TEXT NOT NULL,
               status TEXT NOT NULL,
               scope_json TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY(run_id) REFERENCES agent_runs(id)
             );
             CREATE TABLE IF NOT EXISTS strategy_versions(
               profile_id TEXT NOT NULL,
               strategy_id TEXT NOT NULL,
               version TEXT NOT NULL,
               lifecycle TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
               PRIMARY KEY(profile_id, strategy_id, version),
               FOREIGN KEY(profile_id) REFERENCES profiles(id)
             );
             COMMIT;",
        )?;
        let has_profile_id = {
            let mut statement = connection.prepare("PRAGMA table_info(audit_events)")?;
            let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
            columns
                .collect::<Result<Vec<_>, _>>()?
                .iter()
                .any(|column| column == "profile_id")
        };
        if !has_profile_id {
            connection.execute_batch(
                "ALTER TABLE audit_events ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';",
            )?;
        }
        connection.execute_batch(
            "BEGIN;
             UPDATE audit_events
                SET profile_id = COALESCE((SELECT profile_id FROM executions WHERE execution_key = audit_events.aggregate_id), profile_id)
              WHERE profile_id = '' AND aggregate_type = 'execution';
             UPDATE audit_events
                SET profile_id = COALESCE((SELECT profile_id FROM agent_runs WHERE id = audit_events.aggregate_id), profile_id)
              WHERE profile_id = '' AND aggregate_type = 'agent_run';
             UPDATE audit_events
                SET profile_id = COALESCE((SELECT profile_id FROM research_snapshots WHERE content_hash = audit_events.aggregate_id LIMIT 1), profile_id)
              WHERE profile_id = '' AND aggregate_type = 'research_snapshot';
             UPDATE audit_events
                SET profile_id = COALESCE(json_extract(payload_json, '$.snapshot.profile_id'), profile_id)
              WHERE profile_id = '' AND aggregate_type = 'recommendation';
             UPDATE schema_meta SET version = 4 WHERE version < 4;
             COMMIT;",
        )?;
        Ok(())
    }

    pub fn put_setting<T: serde::Serialize>(&self, key: &str, value: &T) -> anyhow::Result<()> {
        let value_json = serde_json::to_string(value)?;
        self.connection.lock().unwrap().execute(
            "INSERT INTO app_settings(key, value_json, updated_at) VALUES(?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=CURRENT_TIMESTAMP",
            params![key, value_json],
        )?;
        Ok(())
    }

    pub fn get_setting<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> anyhow::Result<Option<T>> {
        let value: Option<String> = self
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT value_json FROM app_settings WHERE key=?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|json| serde_json::from_str(&json).map_err(Into::into))
            .transpose()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn begin_agent_run(
        &self,
        run_id: &str,
        conversation_id: &str,
        profile_id: &str,
        instrument_id: Option<&str>,
        provider_base_url: &str,
        model: &str,
        request_hash: &str,
        context_manifest: &serde_json::Value,
    ) -> anyhow::Result<()> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO conversations(id, profile_id, instrument_id) VALUES(?1, ?2, ?3)",
            params![conversation_id, profile_id, instrument_id],
        )?;
        let scope: (String, Option<String>) = tx.query_row(
            "SELECT profile_id, instrument_id FROM conversations WHERE id=?1",
            params![conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        anyhow::ensure!(
            scope.0 == profile_id && scope.1.as_deref() == instrument_id,
            "conversation scope cannot cross profiles or instruments"
        );
        tx.execute(
            "INSERT INTO agent_runs(id, conversation_id, profile_id, instrument_id, provider_base_url, model, status, request_hash, context_manifest_json)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, 'RUNNING', ?7, ?8)",
            params![run_id, conversation_id, profile_id, instrument_id, provider_base_url, model, request_hash, serde_json::to_string(context_manifest)?],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'agent_run', ?2, 'started', ?3)",
            params![profile_id, run_id, serde_json::to_string(&serde_json::json!({"profile_id": profile_id, "instrument_id": instrument_id, "request_hash": request_hash}))?],
        )?;
        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_agent_run(
        &self,
        run_id: &str,
        artifact_id: &str,
        profile_id: &str,
        artifact_type: &str,
        content: &str,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    ) -> anyhow::Result<()> {
        let input_tokens =
            i64::try_from(input_tokens).context("input token count exceeds SQLite range")?;
        let output_tokens =
            i64::try_from(output_tokens).context("output token count exceeds SQLite range")?;
        let total_tokens =
            i64::try_from(total_tokens).context("total token count exceeds SQLite range")?;
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run_profile: String = tx.query_row(
            "SELECT profile_id FROM agent_runs WHERE id=?1 AND status='RUNNING'",
            params![run_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            run_profile == profile_id,
            "artifact profile does not match agent run"
        );
        tx.execute(
            "INSERT INTO agent_artifacts(id, run_id, profile_id, artifact_type, lifecycle, content) VALUES(?1, ?2, ?3, ?4, 'DRAFT', ?5)",
            params![artifact_id, run_id, profile_id, artifact_type, content],
        )?;
        tx.execute(
            "INSERT INTO usage_records(run_id, input_tokens, output_tokens, total_tokens) VALUES(?1, ?2, ?3, ?4)",
            params![run_id, input_tokens, output_tokens, total_tokens],
        )?;
        tx.execute(
            "UPDATE agent_runs SET status='COMPLETED', completed_at=CURRENT_TIMESTAMP WHERE id=?1",
            params![run_id],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'agent_run', ?2, 'draft_created', ?3)",
            params![profile_id, run_id, serde_json::to_string(&serde_json::json!({"artifact_id": artifact_id, "lifecycle": "DRAFT", "input_tokens": input_tokens, "output_tokens": output_tokens}))?],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn fail_agent_run(&self, run_id: &str, error_code: &str) -> anyhow::Result<()> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let profile_id: String = tx.query_row(
            "SELECT profile_id FROM agent_runs WHERE id=?1 AND status='RUNNING'",
            params![run_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "UPDATE agent_runs SET status='FAILED', error_code=?2, completed_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='RUNNING'",
            params![run_id, error_code],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'agent_run', ?2, 'failed', ?3)",
            params![profile_id, run_id, serde_json::to_string(&serde_json::json!({"error_code": error_code}))?],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn agent_run(&self, run_id: &str) -> anyhow::Result<Option<AgentRunSnapshot>> {
        self.connection.lock().unwrap().query_row(
            "SELECT r.id, r.conversation_id, r.profile_id, r.instrument_id, r.status, u.input_tokens, u.output_tokens
             FROM agent_runs r LEFT JOIN usage_records u ON u.run_id=r.id WHERE r.id=?1",
            params![run_id],
            |row| Ok(AgentRunSnapshot { id: row.get(0)?, conversation_id: row.get(1)?, profile_id: row.get(2)?, instrument_id: row.get(3)?, status: row.get(4)?, input_tokens: row.get(5)?, output_tokens: row.get(6)? }),
        ).optional().map_err(Into::into)
    }

    pub fn integrity_check(&self) -> anyhow::Result<bool> {
        let value: String =
            self.connection
                .lock()
                .unwrap()
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        Ok(value == "ok")
    }

    pub fn schema_version(&self) -> anyhow::Result<i64> {
        self.connection
            .lock()
            .unwrap()
            .query_row("SELECT version FROM schema_meta", [], |row| row.get(0))
            .map_err(Into::into)
    }

    pub fn seed_ledger(&self, snapshot: &LedgerSnapshot, profile_name: &str) -> anyhow::Result<()> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT OR IGNORE INTO profiles(id, name) VALUES(?1, ?2)",
            params![snapshot.profile_id, profile_name],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO instruments(id, symbol, currency) VALUES(?1, ?2, ?3)",
            params![snapshot.instrument_id, "1810.HK", snapshot.currency],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO positions(profile_id, instrument_id, quantity) VALUES(?1, ?2, ?3)",
            params![snapshot.profile_id, snapshot.instrument_id, snapshot.quantity.to_string()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO cash_accounts(profile_id, currency, balance, verification_status) VALUES(?1, ?2, ?3, 'inferred_needs_verification')",
            params![snapshot.profile_id, snapshot.currency, snapshot.cash.to_string()],
        )?;
        tx.commit()?;
        drop(connection);
        let stored = self.ledger_snapshot(
            &snapshot.profile_id,
            &snapshot.instrument_id,
            &snapshot.currency,
        )?;
        anyhow::ensure!(
            stored == *snapshot,
            "existing ledger seed conflicts with requested seed"
        );
        Ok(())
    }

    pub fn ledger_snapshot(
        &self,
        profile_id: &str,
        instrument_id: &str,
        currency: &str,
    ) -> anyhow::Result<LedgerSnapshot> {
        let connection = self.connection.lock().unwrap();
        read_snapshot(&connection, profile_id, instrument_id, currency)
    }

    pub fn ledger_exists(
        &self,
        profile_id: &str,
        instrument_id: &str,
        currency: &str,
    ) -> anyhow::Result<bool> {
        let connection = self.connection.lock().unwrap();
        Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM positions p JOIN cash_accounts c ON c.profile_id = p.profile_id AND c.currency = ?3 WHERE p.profile_id = ?1 AND p.instrument_id = ?2)",
            params![profile_id, instrument_id, currency],
            |row| row.get(0),
        )?)
    }

    pub fn initialize_ledger_baseline(
        &self,
        profile_id: &str,
        instrument_id: &str,
        currency: &str,
        quantity: Decimal,
        cash: Decimal,
    ) -> anyhow::Result<LedgerSnapshot> {
        anyhow::ensure!(
            quantity >= Decimal::ZERO && cash >= Decimal::ZERO,
            "ledger baseline cannot be negative"
        );
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_snapshot(&transaction, profile_id, instrument_id, currency)?;
        let executions: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM executions WHERE profile_id = ?1)",
            params![profile_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            !executions && current.quantity == Decimal::ZERO && current.cash == Decimal::ZERO,
            "ledger baseline is already initialized"
        );
        transaction.execute(
            "UPDATE positions SET quantity = ?3 WHERE profile_id = ?1 AND instrument_id = ?2",
            params![profile_id, instrument_id, quantity.to_string()],
        )?;
        transaction.execute("UPDATE cash_accounts SET balance = ?3, verification_status = 'user_verified' WHERE profile_id = ?1 AND currency = ?2", params![profile_id, currency, cash.to_string()])?;
        let snapshot = LedgerSnapshot {
            profile_id: profile_id.into(),
            instrument_id: instrument_id.into(),
            quantity,
            cash,
            currency: currency.into(),
        };
        transaction.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES(?1, 'ledger', ?1, 'baseline_initialized', ?2)",
            params![profile_id, serde_json::to_string(&snapshot)?],
        )?;
        transaction.commit()?;
        Ok(snapshot)
    }

    pub fn execution_history(&self, profile_id: &str) -> anyhow::Result<Vec<ExecutionHistoryItem>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT execution_key, profile_id, instrument_id, side, traded_at, quantity, price,
                    gross_amount, net_cash_flow, stamp_duty, clearing_fee, transfer_fee,
                    commission, external_id, created_at
             FROM executions WHERE profile_id = ?1 ORDER BY traded_at DESC, created_at DESC",
        )?;
        let rows = statement.query_map(params![profile_id], |row| {
            Ok(ExecutionHistoryItem {
                execution_key: row.get(0)?,
                profile_id: row.get(1)?,
                instrument_id: row.get(2)?,
                side: row.get(3)?,
                traded_at: row.get(4)?,
                quantity: row.get(5)?,
                price: row.get(6)?,
                gross_amount: row.get(7)?,
                net_cash_flow: row.get(8)?,
                stamp_duty: row.get(9)?,
                clearing_fee: row.get(10)?,
                transfer_fee: row.get(11)?,
                commission: row.get(12)?,
                external_id: row.get(13)?,
                created_at: row.get(14)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn audit_history(&self, profile_id: &str) -> anyhow::Result<Vec<AuditEventItem>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id, profile_id, aggregate_type, aggregate_id, event_type, payload_json, created_at
             FROM audit_events WHERE profile_id = ?1 ORDER BY id DESC",
        )?;
        let rows = statement.query_map(params![profile_id], |row| {
            let payload: String = row.get(5)?;
            let payload = serde_json::from_str(&payload).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(AuditEventItem {
                id: row.get(0)?,
                profile_id: row.get(1)?,
                aggregate_type: row.get(2)?,
                aggregate_id: row.get(3)?,
                event_type: row.get(4)?,
                payload,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn decision_history(&self, profile_id: &str) -> anyhow::Result<Vec<Recommendation>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection
            .prepare("SELECT payload_json FROM recommendations ORDER BY created_at DESC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut decisions = Vec::new();
        for payload in rows {
            let item: Recommendation = serde_json::from_str(&payload?)?;
            if item.snapshot.profile_id == profile_id {
                decisions.push(item);
            }
        }
        Ok(decisions)
    }

    pub fn record_execution(
        &self,
        profile_id: &str,
        currency: &str,
        execution: &Execution,
    ) -> anyhow::Result<RecordExecutionResult> {
        let key = execution.execution_key(profile_id);
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM executions WHERE execution_key = ?1)",
            params![key],
            |row| row.get(0),
        )?;
        if exists {
            let snapshot = read_snapshot(&tx, profile_id, &execution.instrument_id, currency)?;
            tx.commit()?;
            return Ok(RecordExecutionResult {
                applied: false,
                snapshot,
            });
        }

        let before = read_snapshot(&tx, profile_id, &execution.instrument_id, currency)?;
        let mut ledger = Ledger::new(
            profile_id,
            &execution.instrument_id,
            before.quantity,
            before.cash,
        );
        ledger.apply(execution)?;
        tx.execute(
            "INSERT INTO executions(execution_key, profile_id, instrument_id, side, traded_at, quantity, price, gross_amount, net_cash_flow, stamp_duty, clearing_fee, transfer_fee, commission, external_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                key, profile_id, execution.instrument_id,
                match execution.side { Side::Buy => "buy", Side::Sell => "sell" },
                execution.traded_at, execution.quantity.to_string(), execution.price.to_string(),
                execution.gross_amount().to_string(), execution.net_cash_flow().to_string(),
                execution.fees.stamp_duty.to_string(), execution.fees.clearing_fee.to_string(),
                execution.fees.transfer_fee.to_string(), execution.fees.commission.to_string(),
                execution.external_id
            ],
        )?;
        tx.execute(
            "UPDATE positions SET quantity = ?3 WHERE profile_id = ?1 AND instrument_id = ?2",
            params![
                profile_id,
                execution.instrument_id,
                ledger.quantity.to_string()
            ],
        )?;
        tx.execute(
            "UPDATE cash_accounts SET balance = ?3 WHERE profile_id = ?1 AND currency = ?2",
            params![profile_id, currency, ledger.cash.to_string()],
        )?;
        let audit_payload = serde_json::json!({
            "execution_key": key,
            "quantity_after": ledger.quantity.to_string(),
            "cash_after": ledger.cash.to_string()
        });
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'execution', ?2, 'recorded', ?3)",
            params![profile_id, key, serde_json::to_string(&audit_payload)?],
        )?;
        let snapshot = LedgerSnapshot {
            profile_id: profile_id.into(),
            instrument_id: execution.instrument_id.clone(),
            quantity: ledger.quantity,
            cash: ledger.cash,
            currency: currency.into(),
        };
        tx.commit()?;
        Ok(RecordExecutionResult {
            applied: true,
            snapshot,
        })
    }

    pub fn revise_execution_fees(
        &self,
        profile_id: &str,
        currency: &str,
        execution_key: &str,
        fees: &margin_safety_domain::FeeBreakdown,
    ) -> anyhow::Result<RecordExecutionResult> {
        anyhow::ensure!(
            fees.stamp_duty >= Decimal::ZERO
                && fees.clearing_fee >= Decimal::ZERO
                && fees.transfer_fee >= Decimal::ZERO
                && fees.commission >= Decimal::ZERO,
            "execution fees cannot be negative"
        );
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (instrument_id, side, gross, old_net, old_fees): (String, String, String, String, margin_safety_domain::FeeBreakdown) = transaction.query_row(
            "SELECT instrument_id, side, gross_amount, net_cash_flow, stamp_duty, clearing_fee, transfer_fee, commission
             FROM executions WHERE execution_key = ?1 AND profile_id = ?2",
            params![execution_key, profile_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, margin_safety_domain::FeeBreakdown { stamp_duty: Decimal::from_str(&row.get::<_, String>(4)?).unwrap(), clearing_fee: Decimal::from_str(&row.get::<_, String>(5)?).unwrap(), transfer_fee: Decimal::from_str(&row.get::<_, String>(6)?).unwrap(), commission: Decimal::from_str(&row.get::<_, String>(7)?).unwrap() }))
        ).context("execution is missing from this profile")?;
        let before = read_snapshot(&transaction, profile_id, &instrument_id, currency)?;
        if old_fees == *fees {
            transaction.commit()?;
            return Ok(RecordExecutionResult {
                applied: false,
                snapshot: before,
            });
        }
        let gross = Decimal::from_str(&gross)?;
        let old_net = Decimal::from_str(&old_net)?;
        let new_net = if side == "sell" {
            gross - fees.total()
        } else {
            -(gross + fees.total())
        };
        let new_cash = before.cash + new_net - old_net;
        anyhow::ensure!(
            new_cash >= Decimal::ZERO,
            "fee revision would make cash negative"
        );
        transaction.execute(
            "UPDATE executions SET net_cash_flow = ?1, stamp_duty = ?2, clearing_fee = ?3, transfer_fee = ?4, commission = ?5 WHERE execution_key = ?6",
            params![new_net.to_string(), fees.stamp_duty.to_string(), fees.clearing_fee.to_string(), fees.transfer_fee.to_string(), fees.commission.to_string(), execution_key],
        )?;
        transaction.execute(
            "UPDATE cash_accounts SET balance = ?3 WHERE profile_id = ?1 AND currency = ?2",
            params![profile_id, currency, new_cash.to_string()],
        )?;
        let payload = serde_json::json!({"old_fees": old_fees, "new_fees": fees, "old_net_cash_flow": old_net.to_string(), "new_net_cash_flow": new_net.to_string(), "cash_after": new_cash.to_string()});
        transaction.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'execution', ?2, 'fees_revised', ?3)",
            params![profile_id, execution_key, serde_json::to_string(&payload)?],
        )?;
        let snapshot = LedgerSnapshot {
            cash: new_cash,
            ..before
        };
        transaction.commit()?;
        Ok(RecordExecutionResult {
            applied: true,
            snapshot,
        })
    }

    pub fn record_execution_for_decision(
        &self,
        profile_id: &str,
        currency: &str,
        decision_key: &str,
        execution: &Execution,
    ) -> anyhow::Result<(RecordExecutionResult, Recommendation)> {
        let execution_key = execution.execution_key(profile_id);
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let recommendation_payload: String = tx.query_row(
            "SELECT payload_json FROM recommendations WHERE decision_key = ?1",
            params![decision_key],
            |row| row.get(0),
        )?;
        let mut recommendation: Recommendation = serde_json::from_str(&recommendation_payload)?;
        anyhow::ensure!(
            recommendation.snapshot.profile_id == profile_id,
            "decision belongs to another profile"
        );
        let execution_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM executions WHERE execution_key = ?1)",
            params![execution_key],
            |row| row.get(0),
        )?;
        let fill_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM decision_fills WHERE decision_key = ?1 AND execution_key = ?2)",
            params![decision_key, execution_key],
            |row| row.get(0),
        )?;
        if execution_exists {
            anyhow::ensure!(
                fill_exists,
                "execution already belongs to the ledger without this decision"
            );
            let snapshot = read_snapshot(&tx, profile_id, &execution.instrument_id, currency)?;
            tx.commit()?;
            return Ok((
                RecordExecutionResult {
                    applied: false,
                    snapshot,
                },
                recommendation,
            ));
        }
        anyhow::ensure!(!fill_exists, "decision fill exists without its execution");

        let before = read_snapshot(&tx, profile_id, &execution.instrument_id, currency)?;
        let mut ledger = Ledger::new(
            profile_id,
            &execution.instrument_id,
            before.quantity,
            before.cash,
        );
        ledger.apply(execution)?;
        recommendation.record_fill(execution.quantity)?;
        tx.execute(
            "INSERT INTO executions(execution_key, profile_id, instrument_id, side, traded_at, quantity, price, gross_amount, net_cash_flow, stamp_duty, clearing_fee, transfer_fee, commission, external_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                execution_key, profile_id, execution.instrument_id,
                match execution.side { Side::Buy => "buy", Side::Sell => "sell" },
                execution.traded_at, execution.quantity.to_string(), execution.price.to_string(),
                execution.gross_amount().to_string(), execution.net_cash_flow().to_string(),
                execution.fees.stamp_duty.to_string(), execution.fees.clearing_fee.to_string(),
                execution.fees.transfer_fee.to_string(), execution.fees.commission.to_string(),
                execution.external_id
            ],
        )?;
        tx.execute(
            "UPDATE positions SET quantity = ?3 WHERE profile_id = ?1 AND instrument_id = ?2",
            params![
                profile_id,
                execution.instrument_id,
                ledger.quantity.to_string()
            ],
        )?;
        tx.execute(
            "UPDATE cash_accounts SET balance = ?3 WHERE profile_id = ?1 AND currency = ?2",
            params![profile_id, currency, ledger.cash.to_string()],
        )?;
        tx.execute(
            "INSERT INTO decision_fills(decision_key, execution_key, quantity) VALUES(?1, ?2, ?3)",
            params![decision_key, execution_key, execution.quantity.to_string()],
        )?;
        let updated = serde_json::to_string(&recommendation)?;
        tx.execute(
            "UPDATE recommendations SET status = ?2, payload_json = ?3 WHERE decision_key = ?1",
            params![
                decision_key,
                recommendation_status_text(recommendation.status),
                updated
            ],
        )?;
        let execution_audit = serde_json::json!({
            "execution_key": execution_key,
            "decision_key": decision_key,
            "quantity_after": ledger.quantity.to_string(),
            "cash_after": ledger.cash.to_string()
        });
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'execution', ?2, 'recorded_for_decision', ?3)",
            params![profile_id, execution_key, serde_json::to_string(&execution_audit)?],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'execution_recorded', ?3)",
            params![profile_id, decision_key, updated],
        )?;
        let snapshot = LedgerSnapshot {
            profile_id: profile_id.into(),
            instrument_id: execution.instrument_id.clone(),
            quantity: ledger.quantity,
            cash: ledger.cash,
            currency: currency.into(),
        };
        tx.commit()?;
        Ok((
            RecordExecutionResult {
                applied: true,
                snapshot,
            },
            recommendation,
        ))
    }

    pub fn accept_decision(&self, decision_key: &str) -> anyhow::Result<Recommendation> {
        self.mutate_decision(decision_key, "accepted", |item| item.accept())
    }

    pub fn reject_decision(
        &self,
        decision_key: &str,
        reason: &str,
    ) -> anyhow::Result<Recommendation> {
        self.mutate_decision(decision_key, "rejected", |item| item.reject(reason))
    }

    pub fn supersede_decision(
        &self,
        decision_key: &str,
        replacement_key: &str,
    ) -> anyhow::Result<Recommendation> {
        self.mutate_decision(decision_key, "superseded", |item| {
            item.supersede(replacement_key)
        })
    }

    pub fn supersede_open_decisions_for_profile(
        &self,
        profile_id: &str,
        replacement_key: &str,
    ) -> anyhow::Result<Vec<String>> {
        let candidates = {
            let connection = self.connection.lock().unwrap();
            let mut statement = connection
                .prepare("SELECT payload_json FROM recommendations WHERE decision_key <> ?1")?;
            let rows =
                statement.query_map(params![replacement_key], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut superseded = Vec::new();
        for payload in candidates {
            let item: Recommendation = serde_json::from_str(&payload)?;
            if item.snapshot.profile_id == profile_id
                && matches!(
                    item.status,
                    RecommendationStatus::Proposed
                        | RecommendationStatus::Accepted
                        | RecommendationStatus::PartiallyFilled
                )
            {
                self.supersede_decision(&item.decision_key, replacement_key)?;
                superseded.push(item.decision_key);
            }
        }
        Ok(superseded)
    }

    pub fn insert_superseding_open(&self, item: &Recommendation) -> anyhow::Result<bool> {
        let payload = serde_json::to_string(item)?;
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM recommendations WHERE decision_key = ?1)",
            params![item.decision_key],
            |row| row.get(0),
        )?;
        if exists {
            transaction.commit()?;
            return Ok(false);
        }
        let candidates = {
            let mut statement =
                transaction.prepare("SELECT decision_key, payload_json FROM recommendations")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for (key, candidate_payload) in candidates {
            let mut candidate: Recommendation = serde_json::from_str(&candidate_payload)?;
            if candidate.snapshot.profile_id == item.snapshot.profile_id
                && matches!(
                    candidate.status,
                    RecommendationStatus::Proposed
                        | RecommendationStatus::Accepted
                        | RecommendationStatus::PartiallyFilled
                )
            {
                candidate.supersede(&item.decision_key)?;
                let updated = serde_json::to_string(&candidate)?;
                transaction.execute("UPDATE recommendations SET status = 'superseded', payload_json = ?2 WHERE decision_key = ?1", params![key, updated])?;
                transaction.execute("INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'superseded', ?3)", params![item.snapshot.profile_id, key, updated])?;
            }
        }
        transaction.execute(
            "INSERT INTO recommendations(decision_key, status, payload_json) VALUES(?1, ?2, ?3)",
            params![
                item.decision_key,
                recommendation_status_text(item.status),
                payload
            ],
        )?;
        transaction.execute("INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'created', ?3)", params![item.snapshot.profile_id, item.decision_key, payload])?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn expire_open_decisions_for_profile(
        &self,
        profile_id: &str,
    ) -> anyhow::Result<Vec<String>> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidates = {
            let mut statement =
                transaction.prepare("SELECT decision_key, payload_json FROM recommendations")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut expired = Vec::new();
        for (key, payload) in candidates {
            let mut item: Recommendation = serde_json::from_str(&payload)?;
            if item.snapshot.profile_id != profile_id {
                continue;
            }
            if matches!(
                item.status,
                RecommendationStatus::Proposed
                    | RecommendationStatus::Accepted
                    | RecommendationStatus::PartiallyFilled
            ) {
                item.transition(RecommendationStatus::Expired)?;
                let updated = serde_json::to_string(&item)?;
                transaction.execute("UPDATE recommendations SET status = 'expired', payload_json = ?2 WHERE decision_key = ?1", params![key, updated])?;
                transaction.execute("INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'expired', ?3)", params![profile_id, key, updated])?;
                expired.push(key);
            }
        }
        transaction.commit()?;
        Ok(expired)
    }

    fn mutate_decision<F>(
        &self,
        decision_key: &str,
        event_type: &str,
        mutate: F,
    ) -> anyhow::Result<Recommendation>
    where
        F: FnOnce(&mut Recommendation) -> Result<(), margin_safety_domain::InvalidTransition>,
    {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let payload: String = tx.query_row(
            "SELECT payload_json FROM recommendations WHERE decision_key = ?1",
            params![decision_key],
            |row| row.get(0),
        )?;
        let mut item: Recommendation = serde_json::from_str(&payload)?;
        mutate(&mut item)?;
        let updated = serde_json::to_string(&item)?;
        tx.execute(
            "UPDATE recommendations SET status = ?2, payload_json = ?3 WHERE decision_key = ?1",
            params![
                decision_key,
                recommendation_status_text(item.status),
                updated
            ],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, ?3, ?4)",
            params![item.snapshot.profile_id, decision_key, event_type, updated],
        )?;
        tx.commit()?;
        Ok(item)
    }

    pub fn record_decision_fill(
        &self,
        decision_key: &str,
        execution_key: &str,
        quantity: Decimal,
    ) -> anyhow::Result<Recommendation> {
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM decision_fills WHERE decision_key = ?1 AND execution_key = ?2)",
            params![decision_key, execution_key],
            |row| row.get(0),
        )?;
        let payload: String = tx.query_row(
            "SELECT payload_json FROM recommendations WHERE decision_key = ?1",
            params![decision_key],
            |row| row.get(0),
        )?;
        let mut item: Recommendation = serde_json::from_str(&payload)?;
        if existing {
            tx.commit()?;
            return Ok(item);
        }
        item.record_fill(quantity)?;
        let updated = serde_json::to_string(&item)?;
        tx.execute(
            "INSERT INTO decision_fills(decision_key, execution_key, quantity) VALUES(?1, ?2, ?3)",
            params![decision_key, execution_key, quantity.to_string()],
        )?;
        tx.execute(
            "UPDATE recommendations SET status = ?2, payload_json = ?3 WHERE decision_key = ?1",
            params![
                decision_key,
                recommendation_status_text(item.status),
                updated
            ],
        )?;
        tx.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'execution_recorded', ?3)",
            params![item.snapshot.profile_id, decision_key, updated],
        )?;
        tx.commit()?;
        Ok(item)
    }

    pub fn replay_decision(&self, decision_key: &str) -> anyhow::Result<bool> {
        let item = self
            .find_by_decision_key(decision_key)?
            .context("decision not found")?;
        Ok(item.replay_is_deterministic())
    }

    pub fn store_market_quote(&self, snapshot: &MarketQuoteSnapshot) -> anyhow::Result<bool> {
        self.store_research_snapshot(
            &snapshot.profile_id,
            &snapshot.instrument_id,
            "market_quote",
            &snapshot.content_hash(),
            snapshot,
        )
    }

    pub fn latest_market_quote(
        &self,
        profile_id: &str,
        instrument_id: &str,
    ) -> anyhow::Result<Option<MarketQuoteSnapshot>> {
        self.latest_research_snapshot(profile_id, instrument_id, "market_quote")
    }

    pub fn store_fundamentals(&self, snapshot: &FundamentalSnapshot) -> anyhow::Result<bool> {
        self.store_research_snapshot(
            &snapshot.profile_id,
            &snapshot.instrument_id,
            "fundamentals",
            &snapshot.content_hash(),
            snapshot,
        )
    }

    pub fn latest_fundamentals(
        &self,
        profile_id: &str,
        instrument_id: &str,
    ) -> anyhow::Result<Option<FundamentalSnapshot>> {
        self.latest_research_snapshot(profile_id, instrument_id, "fundamentals")
    }

    pub fn store_sotp(&self, snapshot: &SotpValuation) -> anyhow::Result<bool> {
        self.store_research_snapshot(
            &snapshot.profile_id,
            &snapshot.instrument_id,
            "sotp",
            &snapshot.content_hash(),
            snapshot,
        )
    }

    pub fn latest_sotp(
        &self,
        profile_id: &str,
        instrument_id: &str,
    ) -> anyhow::Result<Option<SotpValuation>> {
        self.latest_research_snapshot(profile_id, instrument_id, "sotp")
    }

    pub fn store_value_assessment(
        &self,
        profile_id: &str,
        instrument_id: &str,
        assessment: &XiaomiValueAssessment,
    ) -> anyhow::Result<bool> {
        self.store_research_snapshot(
            profile_id,
            instrument_id,
            "value_assessment",
            &assessment.content_hash(),
            assessment,
        )
    }

    pub fn latest_value_assessment(
        &self,
        profile_id: &str,
        instrument_id: &str,
    ) -> anyhow::Result<Option<XiaomiValueAssessment>> {
        self.latest_research_snapshot(profile_id, instrument_id, "value_assessment")
    }

    pub fn store_reverse_dcf(&self, snapshot: &ReverseDcfSnapshot) -> anyhow::Result<bool> {
        self.store_research_snapshot(
            &snapshot.profile_id,
            &snapshot.instrument_id,
            "reverse_dcf",
            &snapshot.content_hash(),
            snapshot,
        )
    }

    pub fn latest_reverse_dcf(
        &self,
        profile_id: &str,
        instrument_id: &str,
    ) -> anyhow::Result<Option<ReverseDcfSnapshot>> {
        self.latest_research_snapshot(profile_id, instrument_id, "reverse_dcf")
    }

    pub fn save_strategy_draft(
        &self,
        profile_id: &str,
        strategy: &StrategyDraft,
    ) -> anyhow::Result<bool> {
        strategy.validate_as_draft()?;
        let payload = serde_json::to_string(strategy)?;
        let content_hash = hex::encode(Sha256::digest(payload.as_bytes()));
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT content_hash FROM strategy_versions
                 WHERE profile_id = ?1 AND strategy_id = ?2 AND version = ?3",
                params![profile_id, strategy.strategy_id, strategy.version],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(existing_hash) = existing {
            anyhow::ensure!(
                existing_hash == content_hash,
                "strategy version already exists with different content"
            );
            return Ok(false);
        }
        let aggregate_id = format!("{}:{}", strategy.strategy_id, strategy.version);
        transaction.execute(
            "INSERT INTO strategy_versions(profile_id, strategy_id, version, lifecycle, content_hash, payload_json)
             VALUES(?1, ?2, ?3, 'DRAFT', ?4, ?5)",
            params![profile_id, strategy.strategy_id, strategy.version, content_hash, payload],
        )?;
        transaction.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES(?1, 'strategy_version', ?2, 'draft_created', ?3)",
            params![profile_id, aggregate_id, payload],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn validate_strategy(
        &self,
        profile_id: &str,
        strategy_id: &str,
        version: &str,
    ) -> anyhow::Result<StrategyDraft> {
        self.transition_strategy(profile_id, strategy_id, version, false)
    }

    pub fn publish_strategy(
        &self,
        profile_id: &str,
        strategy_id: &str,
        version: &str,
    ) -> anyhow::Result<StrategyDraft> {
        self.transition_strategy(profile_id, strategy_id, version, true)
    }

    fn transition_strategy(
        &self,
        profile_id: &str,
        strategy_id: &str,
        version: &str,
        publish: bool,
    ) -> anyhow::Result<StrategyDraft> {
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let payload: String = transaction
            .query_row(
                "SELECT payload_json FROM strategy_versions
                 WHERE profile_id = ?1 AND strategy_id = ?2 AND version = ?3",
                params![profile_id, strategy_id, version],
                |row| row.get(0),
            )
            .context("strategy version is missing from this profile")?;
        let current: StrategyDraft = serde_json::from_str(&payload)?;
        let next = if publish {
            current.publish()?
        } else {
            current.validate()?
        };
        if publish {
            let published_payloads = {
                let mut statement = transaction.prepare(
                    "SELECT version, payload_json FROM strategy_versions
                     WHERE profile_id = ?1 AND strategy_id = ?2 AND lifecycle = 'PUBLISHED' AND version <> ?3",
                )?;
                let rows = statement
                    .query_map(params![profile_id, strategy_id, version], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (old_version, old_payload) in published_payloads {
                let mut old: StrategyDraft = serde_json::from_str(&old_payload)?;
                old.lifecycle = ResearchLifecycle::Superseded;
                let rebound = serde_json::to_string(&old)?;
                let hash = hex::encode(Sha256::digest(rebound.as_bytes()));
                transaction.execute(
                    "UPDATE strategy_versions SET lifecycle = 'SUPERSEDED', content_hash = ?1, payload_json = ?2, updated_at = CURRENT_TIMESTAMP
                     WHERE profile_id = ?3 AND strategy_id = ?4 AND version = ?5",
                    params![hash, rebound, profile_id, strategy_id, old_version],
                )?;
                transaction.execute(
                    "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json)
                     VALUES(?1, 'strategy_version', ?2, 'superseded', ?3)",
                    params![profile_id, format!("{strategy_id}:{old_version}"), rebound],
                )?;
            }
        }
        let next_payload = serde_json::to_string(&next)?;
        let next_hash = hex::encode(Sha256::digest(next_payload.as_bytes()));
        let lifecycle = if publish { "PUBLISHED" } else { "VALIDATED" };
        transaction.execute(
            "UPDATE strategy_versions SET lifecycle = ?1, content_hash = ?2, payload_json = ?3, updated_at = CURRENT_TIMESTAMP
             WHERE profile_id = ?4 AND strategy_id = ?5 AND version = ?6",
            params![lifecycle, next_hash, next_payload, profile_id, strategy_id, version],
        )?;
        transaction.execute(
            "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json)
             VALUES(?1, 'strategy_version', ?2, ?3, ?4)",
            params![profile_id, format!("{strategy_id}:{version}"), if publish { "published" } else { "validated" }, next_payload],
        )?;
        transaction.commit()?;
        Ok(next)
    }

    pub fn strategy_history(&self, profile_id: &str) -> anyhow::Result<Vec<StrategyDraft>> {
        let connection = self.connection.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT payload_json FROM strategy_versions WHERE profile_id = ?1
             ORDER BY strategy_id, created_at, version",
        )?;
        let rows = statement.query_map(params![profile_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            serde_json::from_str(&row?).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
    }

    fn store_research_snapshot<T: serde::Serialize>(
        &self,
        profile_id: &str,
        instrument_id: &str,
        kind: &str,
        content_hash: &str,
        snapshot: &T,
    ) -> anyhow::Result<bool> {
        let payload = serde_json::to_string(snapshot)?;
        let mut connection = self.connection.lock().unwrap();
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO research_snapshots(profile_id, instrument_id, snapshot_kind, content_hash, payload_json) VALUES(?1, ?2, ?3, ?4, ?5)",
            params![profile_id, instrument_id, kind, content_hash, payload],
        )?;
        if inserted == 1 {
            tx.execute(
                "INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'research_snapshot', ?2, 'created', ?3)",
                params![profile_id, content_hash, payload],
            )?;
        }
        tx.commit()?;
        Ok(inserted == 1)
    }

    fn latest_research_snapshot<T: serde::de::DeserializeOwned>(
        &self,
        profile_id: &str,
        instrument_id: &str,
        kind: &str,
    ) -> anyhow::Result<Option<T>> {
        let connection = self.connection.lock().unwrap();
        let payload: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM research_snapshots WHERE profile_id = ?1 AND instrument_id = ?2 AND snapshot_kind = ?3 ORDER BY id DESC LIMIT 1",
                params![profile_id, instrument_id, kind],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }
}

fn recommendation_status_text(status: RecommendationStatus) -> &'static str {
    match status {
        RecommendationStatus::Proposed => "proposed",
        RecommendationStatus::Accepted => "accepted",
        RecommendationStatus::Rejected => "rejected",
        RecommendationStatus::PartiallyFilled => "partially_filled",
        RecommendationStatus::Filled => "filled",
        RecommendationStatus::Superseded => "superseded",
        RecommendationStatus::Expired => "expired",
    }
}

fn read_snapshot(
    connection: &Connection,
    profile_id: &str,
    instrument_id: &str,
    currency: &str,
) -> anyhow::Result<LedgerSnapshot> {
    let (quantity, cash): (String, String) = connection.query_row(
        "SELECT p.quantity, c.balance FROM positions p JOIN cash_accounts c ON c.profile_id = p.profile_id AND c.currency = ?3 WHERE p.profile_id = ?1 AND p.instrument_id = ?2",
        params![profile_id, instrument_id, currency],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(LedgerSnapshot {
        profile_id: profile_id.into(),
        instrument_id: instrument_id.into(),
        quantity: Decimal::from_str(&quantity)?,
        cash: Decimal::from_str(&cash)?,
        currency: currency.into(),
    })
}

impl RecommendationRepository for EncryptedDatabase {
    fn find_by_decision_key(&self, key: &str) -> anyhow::Result<Option<Recommendation>> {
        let connection = self.connection.lock().unwrap();
        let json: Option<String> = connection
            .query_row(
                "SELECT payload_json FROM recommendations WHERE decision_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    fn insert(&self, item: &Recommendation) -> anyhow::Result<()> {
        let status = recommendation_status_text(item.status);
        let payload = serde_json::to_string(item)?;
        let mut connection = self.connection.lock().unwrap();
        let transaction = connection.transaction()?;
        let inserted = transaction.execute("INSERT OR IGNORE INTO recommendations(decision_key, status, payload_json) VALUES(?1, ?2, ?3)", params![item.decision_key, status, payload])?;
        if inserted == 1 {
            transaction.execute("INSERT INTO audit_events(profile_id, aggregate_type, aggregate_id, event_type, payload_json) VALUES(?1, 'recommendation', ?2, 'created', ?3)", params![item.snapshot.profile_id, item.decision_key, payload])?;
        }
        transaction.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use chrono::{TimeZone, Utc};
    use margin_safety_domain::{
        Condition, DataOrigin, FeeBreakdown, MarketQuoteSnapshot, SuggestedAction,
    };
    use margin_safety_domain::{DecisionSnapshot, Recommendation};
    use std::collections::BTreeMap;
    use std::str::FromStr;
    use tempfile::tempdir;

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

    fn initial_xiaomi() -> LedgerSnapshot {
        LedgerSnapshot {
            profile_id: "profile-xiaomi-real".into(),
            instrument_id: "HKEX:1810".into(),
            quantity: d("225600"),
            cash: d("87889"),
            currency: "HKD".into(),
        }
    }

    fn stage_two_decision() -> Recommendation {
        let mut facts = BTreeMap::new();
        facts.insert("recommended_quantity".into(), "10560".into());
        facts.insert("stage_1_completed".into(), "true".into());
        facts.insert("actual_cumulative_sold".into(), "12000".into());
        Recommendation::proposed(
            DecisionSnapshot {
                profile_id: "profile-xiaomi-real".into(),
                strategy_version: "xiaomi-four-stage-v1".into(),
                engine_version: "0.1.0".into(),
                facts,
            },
            d("10560"),
        )
    }

    fn later_sell(date: (i32, u32, u32), quantity: &str) -> Execution {
        Execution {
            instrument_id: "HKEX:1810".into(),
            side: Side::Sell,
            traded_at: NaiveDate::from_ymd_opt(date.0, date.1, date.2).unwrap(),
            quantity: d(quantity),
            price: d("30"),
            fees: FeeBreakdown {
                stamp_duty: Decimal::ZERO,
                clearing_fee: Decimal::ZERO,
                transfer_fee: Decimal::ZERO,
                commission: Decimal::ZERO,
            },
            external_id: None,
        }
    }

    #[test]
    fn migration_is_repeatable_and_database_is_healthy() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.migrate().unwrap();
        assert!(db.integrity_check().unwrap());
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn encrypted_profile_catalog_lists_profiles_without_storing_database_keys() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("profiles.catalog.db");
        let key = "11".repeat(32);
        {
            let catalog = ProfileCatalog::open(&path, &key).unwrap();
            assert!(catalog.add("profile-owner", "我的投资档案").unwrap());
            assert!(catalog.add("profile-family", "家人投资档案").unwrap());
            assert!(!catalog.add("profile-owner", "重复名称不会覆盖").unwrap());
        }
        assert_ne!(&std::fs::read(&path).unwrap()[..16], b"SQLite format 3\0");
        let reopened = ProfileCatalog::open(&path, &key).unwrap();
        assert_eq!(
            reopened.list().unwrap(),
            vec![
                ProfileCatalogItem {
                    id: "profile-owner".into(),
                    name: "我的投资档案".into()
                },
                ProfileCatalogItem {
                    id: "profile-family".into(),
                    name: "家人投资档案".into()
                },
            ]
        );
        assert!(ProfileCatalog::open(&path, &"22".repeat(32)).is_err());
    }

    #[test]
    fn portable_export_reencrypts_with_a_new_local_key_without_ledger_drift() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("source.db");
        let restored_path = directory.path().join("restored.db");
        let source_key = "33".repeat(32);
        let target_key = "44".repeat(32);
        let source = EncryptedDatabase::open(&source_path, &source_key).unwrap();
        source
            .seed_ledger(&initial_xiaomi(), "我的投资档案")
            .unwrap();
        source
            .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        let portable = source.export_portable_bytes().unwrap();
        assert_eq!(&portable[..16], b"SQLite format 3\0");
        let restored =
            EncryptedDatabase::restore_portable_bytes(&restored_path, &target_key, &portable)
                .unwrap();
        assert_eq!(
            restored
                .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
                .unwrap(),
            source
                .ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
                .unwrap()
        );
        assert!(
            !restored
                .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
                .unwrap()
                .applied
        );
        drop(restored);
        assert!(EncryptedDatabase::open(&restored_path, &source_key).is_err());
        assert!(EncryptedDatabase::open(&restored_path, &target_key).is_ok());
    }

    #[test]
    fn profile_rebind_preserves_decision_replay_and_execution_idempotency() {
        let directory = tempdir().unwrap();
        let source_path = directory.path().join("source-rebind.db");
        let restored_path = directory.path().join("restored-rebind.db");
        let source = EncryptedDatabase::open(&source_path, &"55".repeat(32)).unwrap();
        source
            .seed_ledger(&initial_xiaomi(), "我的投资档案")
            .unwrap();
        source
            .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        let decision = stage_two_decision();
        source.insert(&decision).unwrap();
        let quote = MarketQuoteSnapshot {
            profile_id: "profile-xiaomi-real".into(),
            instrument_id: "HKEX:1810".into(),
            price: d("25.62"),
            currency: "HKD".into(),
            observed_at: Utc.with_ymd_and_hms(2026, 8, 17, 10, 0, 0).unwrap(),
            valid_until: Utc.with_ymd_and_hms(2026, 8, 18, 10, 0, 0).unwrap(),
            origin: DataOrigin::Manual,
            source_label: "manual fallback".into(),
        };
        source.store_market_quote(&quote).unwrap();
        let portable = source.export_portable_bytes().unwrap();
        let restored =
            EncryptedDatabase::restore_portable_bytes(&restored_path, &"66".repeat(32), &portable)
                .unwrap();
        restored
            .rebind_profile("profile-xiaomi-real", "profile-restored", "恢复档案")
            .unwrap();
        let decisions = restored.decision_history("profile-restored").unwrap();
        assert_eq!(decisions.len(), 1);
        assert_ne!(decisions[0].decision_key, decision.decision_key);
        assert!(restored
            .replay_decision(&decisions[0].decision_key)
            .unwrap());
        let rebound_quote = restored
            .latest_market_quote("profile-restored", "HKEX:1810")
            .unwrap()
            .unwrap();
        assert_eq!(rebound_quote.profile_id, "profile-restored");
        assert!(!restored.store_market_quote(&rebound_quote).unwrap());
        assert!(
            !restored
                .record_execution("profile-restored", "HKD", &xiaomi_execution())
                .unwrap()
                .applied
        );
        assert!(restored
            .decision_history("profile-xiaomi-real")
            .unwrap()
            .is_empty());
        assert!(restored
            .audit_history("profile-xiaomi-real")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn version_one_database_migrates_forward_to_agent_audit_schema() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"CREATE TABLE schema_meta(version INTEGER NOT NULL);
                 INSERT INTO schema_meta(version) VALUES(1);
                 CREATE TABLE audit_events(
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   aggregate_type TEXT NOT NULL,
                   aggregate_id TEXT NOT NULL,
                   event_type TEXT NOT NULL,
                   payload_json TEXT NOT NULL,
                   created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO audit_events(aggregate_type, aggregate_id, event_type, payload_json)
                 VALUES('recommendation', 'legacy-decision', 'created', '{"snapshot":{"profile_id":"legacy-profile"}}');"#,
            )
            .unwrap();
        let db = EncryptedDatabase {
            connection: Mutex::new(connection),
        };
        db.migrate().unwrap();
        assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(db.audit_history("legacy-profile").unwrap().len(), 1);
        assert!(db
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap());
    }

    #[test]
    fn encrypted_profile_settings_round_trip_without_api_key() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        let value = serde_json::json!({"base_url":"https://api.openai.com/","model":"test"});
        db.put_setting("llm.provider-config", &value).unwrap();
        let restored: serde_json::Value = db.get_setting("llm.provider-config").unwrap().unwrap();
        assert_eq!(restored, value);
        assert!(db
            .get_setting::<serde_json::Value>("llm.provider-api-key")
            .unwrap()
            .is_none());
    }

    #[test]
    fn agent_run_is_profile_scoped_and_completes_only_as_draft() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let manifest = serde_json::json!({
            "profile_id": "profile-xiaomi-real",
            "instrument_id": "HKEX:1810",
            "included_sections": ["ledger_summary"],
            "explicitly_excluded": ["api_keys", "other_profiles", "trade_permissions"]
        });
        db.begin_agent_run(
            "run-1",
            "conversation:profile-xiaomi-real:HKEX:1810",
            "profile-xiaomi-real",
            Some("HKEX:1810"),
            "https://api.openai.com/",
            "test-model",
            "request-hash",
            &manifest,
        )
        .unwrap();
        db.complete_agent_run(
            "run-1",
            "artifact-1",
            "profile-xiaomi-real",
            "research_draft",
            "draft content",
            42,
            7,
            49,
        )
        .unwrap();
        let run = db.agent_run("run-1").unwrap().unwrap();
        assert_eq!(run.status, "COMPLETED");
        assert_eq!(run.profile_id, "profile-xiaomi-real");
        assert_eq!(run.input_tokens, Some(42));
        assert_eq!(run.output_tokens, Some(7));
    }

    #[test]
    fn conversation_id_cannot_be_reused_across_profiles() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let mut family = initial_xiaomi();
        family.profile_id = "family-profile".into();
        db.seed_ledger(&family, "家人投资档案").unwrap();
        let manifest = serde_json::json!({});
        db.begin_agent_run(
            "run-owner",
            "shared-conversation",
            "profile-xiaomi-real",
            Some("HKEX:1810"),
            "https://api.openai.com/",
            "test-model",
            "hash-1",
            &manifest,
        )
        .unwrap();
        let error = db
            .begin_agent_run(
                "run-family",
                "shared-conversation",
                "family-profile",
                Some("HKEX:1810"),
                "https://api.openai.com/",
                "test-model",
                "hash-2",
                &manifest,
            )
            .unwrap_err();
        assert!(error.to_string().contains("cannot cross profiles"));
        assert!(db.agent_run("run-family").unwrap().is_none());
    }

    #[test]
    fn failed_agent_call_is_auditable_without_usage_or_artifact() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        db.begin_agent_run(
            "run-failed",
            "failed-conversation",
            "profile-xiaomi-real",
            Some("HKEX:1810"),
            "https://api.openai.com/",
            "test-model",
            "hash-failed",
            &serde_json::json!({}),
        )
        .unwrap();
        db.fail_agent_run("run-failed", "PROVIDER_REQUEST").unwrap();
        let run = db.agent_run("run-failed").unwrap().unwrap();
        assert_eq!(run.status, "FAILED");
        assert_eq!(run.input_tokens, None);
        assert_eq!(run.output_tokens, None);
    }

    #[test]
    fn xiaomi_execution_is_atomic_and_duplicate_safe() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let first = db
            .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        assert!(first.applied);
        assert_eq!(first.snapshot.quantity, d("213600"));
        assert_eq!(first.snapshot.cash, d("395000"));

        let duplicate = db
            .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        assert!(!duplicate.applied);
        assert_eq!(duplicate.snapshot, first.snapshot);
    }

    #[test]
    fn audit_and_activity_queries_are_strictly_profile_scoped() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let mut family = initial_xiaomi();
        family.profile_id = "profile-family".into();
        db.seed_ledger(&family, "家人投资档案").unwrap();
        db.record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        db.record_execution("profile-family", "HKD", &xiaomi_execution())
            .unwrap();

        let owner_executions = db.execution_history("profile-xiaomi-real").unwrap();
        let family_executions = db.execution_history("profile-family").unwrap();
        assert_eq!(owner_executions.len(), 1);
        assert_eq!(family_executions.len(), 1);
        assert!(owner_executions
            .iter()
            .all(|item| item.profile_id == "profile-xiaomi-real"));
        assert!(family_executions
            .iter()
            .all(|item| item.profile_id == "profile-family"));
        let owner_audit = db.audit_history("profile-xiaomi-real").unwrap();
        let family_audit = db.audit_history("profile-family").unwrap();
        assert_eq!(owner_audit.len(), 1);
        assert_eq!(family_audit.len(), 1);
        assert!(owner_audit
            .iter()
            .all(|item| item.profile_id == "profile-xiaomi-real"));
        assert!(family_audit
            .iter()
            .all(|item| item.profile_id == "profile-family"));
        assert_ne!(owner_audit[0].aggregate_id, family_audit[0].aggregate_id);
    }

    #[test]
    fn duplicate_remains_safe_after_database_restart() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        drop(file);
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        {
            let db = EncryptedDatabase::open(&path, key).unwrap();
            db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
            assert!(
                db.record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
                    .unwrap()
                    .applied
            );
        }
        let reopened = EncryptedDatabase::open(&path, key).unwrap();
        let duplicate = reopened
            .record_execution("profile-xiaomi-real", "HKD", &xiaomi_execution())
            .unwrap();
        assert!(!duplicate.applied);
        assert_eq!(duplicate.snapshot.quantity, d("213600"));
        assert_eq!(duplicate.snapshot.cash, d("395000"));
    }

    #[test]
    fn decision_requires_acceptance_and_tracks_idempotent_partial_fills() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        let current = LedgerSnapshot {
            quantity: d("213600"),
            cash: d("395000"),
            ..initial_xiaomi()
        };
        db.seed_ledger(&current, "我的投资档案").unwrap();
        let decision = stage_two_decision();
        db.insert(&decision).unwrap();

        let first_fill = later_sell((2026, 9, 1), "5000");
        let first_key = first_fill.execution_key("profile-xiaomi-real");
        db.record_execution("profile-xiaomi-real", "HKD", &first_fill)
            .unwrap();
        assert!(db
            .record_decision_fill(&decision.decision_key, &first_key, d("5000"))
            .is_err());

        db.accept_decision(&decision.decision_key).unwrap();
        let partial = db
            .record_decision_fill(&decision.decision_key, &first_key, d("5000"))
            .unwrap();
        assert_eq!(partial.status, RecommendationStatus::PartiallyFilled);
        assert_eq!(partial.filled_quantity, d("5000"));
        let duplicate = db
            .record_decision_fill(&decision.decision_key, &first_key, d("5000"))
            .unwrap();
        assert_eq!(duplicate.filled_quantity, d("5000"));

        let final_fill = later_sell((2026, 9, 2), "5560");
        let final_key = final_fill.execution_key("profile-xiaomi-real");
        db.record_execution("profile-xiaomi-real", "HKD", &final_fill)
            .unwrap();
        let filled = db
            .record_decision_fill(&decision.decision_key, &final_key, d("5560"))
            .unwrap();
        assert_eq!(filled.status, RecommendationStatus::Filled);
        assert_eq!(filled.filled_quantity, d("10560"));
        assert!(db.replay_decision(&decision.decision_key).unwrap());
    }

    #[test]
    fn accepted_decision_and_ledger_fill_commit_as_one_idempotent_transaction() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        let current = LedgerSnapshot {
            quantity: d("213600"),
            cash: d("395000"),
            ..initial_xiaomi()
        };
        db.seed_ledger(&current, "我的投资档案").unwrap();
        let decision = stage_two_decision();
        db.insert(&decision).unwrap();
        let fill = later_sell((2026, 9, 1), "5000");
        assert!(db
            .record_execution_for_decision(
                "profile-xiaomi-real",
                "HKD",
                &decision.decision_key,
                &fill,
            )
            .is_err());
        assert_eq!(
            db.ledger_snapshot("profile-xiaomi-real", "HKEX:1810", "HKD")
                .unwrap(),
            current
        );

        db.accept_decision(&decision.decision_key).unwrap();
        let (applied, partial) = db
            .record_execution_for_decision(
                "profile-xiaomi-real",
                "HKD",
                &decision.decision_key,
                &fill,
            )
            .unwrap();
        assert!(applied.applied);
        assert_eq!(partial.status, RecommendationStatus::PartiallyFilled);
        assert_eq!(partial.filled_quantity, d("5000"));
        let (duplicate, unchanged) = db
            .record_execution_for_decision(
                "profile-xiaomi-real",
                "HKD",
                &decision.decision_key,
                &fill,
            )
            .unwrap();
        assert!(!duplicate.applied);
        assert_eq!(unchanged, partial);
        assert_eq!(duplicate.snapshot, applied.snapshot);
    }

    #[test]
    fn research_snapshots_are_content_idempotent_and_profile_isolated() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let observed = Utc.with_ymd_and_hms(2026, 8, 17, 12, 0, 0).unwrap();
        let quote = MarketQuoteSnapshot {
            profile_id: "profile-xiaomi-real".into(),
            instrument_id: "HKEX:1810".into(),
            price: d("25.62"),
            currency: "HKD".into(),
            observed_at: observed,
            valid_until: observed + chrono::Duration::hours(24),
            origin: DataOrigin::Manual,
            source_label: "manual fallback".into(),
        };
        assert!(db.store_market_quote(&quote).unwrap());
        assert!(!db.store_market_quote(&quote).unwrap());
        assert_eq!(
            db.latest_market_quote("profile-xiaomi-real", "HKEX:1810")
                .unwrap(),
            Some(quote)
        );
        assert_eq!(
            db.latest_market_quote("family-profile", "HKEX:1810")
                .unwrap(),
            None
        );
    }

    fn strategy(version: &str) -> StrategyDraft {
        StrategyDraft {
            schema_version: 1,
            strategy_id: "xiaomi-four-stage".into(),
            version: version.into(),
            condition: Condition::HumanConfirmation {
                checklist_id: "rebound-confirmation".into(),
            },
            suggestion: SuggestedAction {
                action: "review_sell_gap".into(),
                reason_code: "STAGE_2_REBOUND".into(),
                invalidation: "fundamental_thesis_invalidated".into(),
            },
            lifecycle: ResearchLifecycle::Draft,
            test_scenarios: vec![margin_safety_domain::StrategyTestScenario {
                name: "confirmed rebound".into(),
                inputs: std::collections::BTreeMap::from([(
                    "rebound-confirmation".into(),
                    serde_json::Value::Bool(true),
                )]),
                expected_match: true,
                expected_action: Some("review_sell_gap".into()),
            }],
        }
    }

    #[test]
    fn strategy_publication_is_explicit_idempotent_and_supersedes_old_version() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        assert!(db
            .save_strategy_draft("profile-xiaomi-real", &strategy("1"))
            .unwrap());
        assert!(!db
            .save_strategy_draft("profile-xiaomi-real", &strategy("1"))
            .unwrap());
        assert!(db
            .publish_strategy("profile-xiaomi-real", "xiaomi-four-stage", "1")
            .is_err());
        db.validate_strategy("profile-xiaomi-real", "xiaomi-four-stage", "1")
            .unwrap();
        assert_eq!(
            db.publish_strategy("profile-xiaomi-real", "xiaomi-four-stage", "1")
                .unwrap()
                .lifecycle,
            ResearchLifecycle::Published
        );

        db.save_strategy_draft("profile-xiaomi-real", &strategy("2"))
            .unwrap();
        db.validate_strategy("profile-xiaomi-real", "xiaomi-four-stage", "2")
            .unwrap();
        db.publish_strategy("profile-xiaomi-real", "xiaomi-four-stage", "2")
            .unwrap();
        let history = db.strategy_history("profile-xiaomi-real").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].lifecycle, ResearchLifecycle::Superseded);
        assert_eq!(history[1].lifecycle, ResearchLifecycle::Published);
        assert!(db.strategy_history("family-profile").unwrap().is_empty());
    }

    #[test]
    fn empty_family_profile_accepts_one_audited_baseline_then_idempotent_executions() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        let empty = LedgerSnapshot {
            profile_id: "family".into(),
            instrument_id: "HKEX:1810".into(),
            quantity: Decimal::ZERO,
            cash: Decimal::ZERO,
            currency: "HKD".into(),
        };
        db.seed_ledger(&empty, "家人投资档案").unwrap();
        let baseline = db
            .initialize_ledger_baseline("family", "HKEX:1810", "HKD", d("1000"), d("50000"))
            .unwrap();
        assert_eq!(baseline.quantity, d("1000"));
        assert!(db
            .initialize_ledger_baseline("family", "HKEX:1810", "HKD", d("1000"), d("50000"))
            .is_err());
        let execution = later_sell((2026, 8, 18), "100");
        assert!(
            db.record_execution("family", "HKD", &execution)
                .unwrap()
                .applied
        );
        assert!(
            !db.record_execution("family", "HKD", &execution)
                .unwrap()
                .applied
        );
        let audits = db.audit_history("family").unwrap();
        assert!(audits
            .iter()
            .any(|item| item.event_type == "baseline_initialized"));
        assert!(audits.iter().any(|item| item.event_type == "recorded"));
    }

    #[test]
    fn fee_revision_keeps_execution_identity_and_applies_only_the_cash_delta() {
        let db = EncryptedDatabase::open_in_memory().unwrap();
        db.seed_ledger(&initial_xiaomi(), "我的投资档案").unwrap();
        let execution = xiaomi_execution();
        let key = execution.execution_key("profile-xiaomi-real");
        db.record_execution("profile-xiaomi-real", "HKD", &execution)
            .unwrap();
        let corrected = FeeBreakdown {
            commission: d("27"),
            ..execution.fees.clone()
        };
        let revised = db
            .revise_execution_fees("profile-xiaomi-real", "HKD", &key, &corrected)
            .unwrap();
        assert!(revised.applied);
        assert_eq!(revised.snapshot.quantity, d("213600"));
        assert_eq!(revised.snapshot.cash, d("394999"));
        assert!(
            !db.revise_execution_fees("profile-xiaomi-real", "HKD", &key, &corrected)
                .unwrap()
                .applied
        );
        let history = db.execution_history("profile-xiaomi-real").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].commission, "27");
        assert!(db
            .audit_history("profile-xiaomi-real")
            .unwrap()
            .iter()
            .any(|item| item.event_type == "fees_revised"));
    }
}

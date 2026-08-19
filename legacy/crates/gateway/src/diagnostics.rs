use anyhow::Context;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const RETENTION_DAYS: i64 = 7;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub level: String,
    pub component: String,
    pub operation: String,
    pub result: String,
    pub message: String,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default)]
    pub fallback_used: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFilter {
    #[serde(default)]
    pub levels: Vec<String>,
    #[serde(default)]
    pub components: Vec<String>,
    #[serde(default)]
    pub query: String,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnostic {
    pub level: String,
    pub operation: String,
    pub message: String,
    pub correlation_id: Option<String>,
}

pub struct DiagnosticStore {
    directory: PathBuf,
    started_at: Instant,
    write_lock: Mutex<()>,
    minimum_level: u8,
}

impl DiagnosticStore {
    pub fn open(data_directory: &Path) -> anyhow::Result<Self> {
        let directory = data_directory.join("logs");
        fs::create_dir_all(&directory)?;
        let minimum_level = level_value(&std::env::var("FIN_ALFRED_LOG").unwrap_or_else(|_| {
            if cfg!(debug_assertions) {
                "DEBUG"
            } else {
                "INFO"
            }
            .into()
        }))
        .unwrap_or(1);
        let store = Self {
            directory,
            started_at: Instant::now(),
            write_lock: Mutex::new(()),
            minimum_level,
        };
        store.prune()?;
        Ok(store)
    }

    pub fn record(&self, mut event: DiagnosticEvent) {
        if level_value(&event.level).unwrap_or(1) < self.minimum_level {
            return;
        }
        event.level = normalized_level(&event.level).into();
        event.component = safe_label(&redact(&event.component, &self.directory), 40);
        event.operation = safe_label(&redact(&event.operation, &self.directory), 80);
        event.result = safe_label(&event.result, 24);
        event.correlation_id = safe_label(&event.correlation_id, 80);
        event.message = redact(&event.message, &self.directory);
        event.source = event.source.map(|value| safe_label(&value, 80));
        let Ok(_guard) = self.write_lock.lock() else {
            return;
        };
        let path = self.directory.join(format!(
            "fin-alfred-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        }
        let _ = self.prune_locked();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn event(
        &self,
        level: &str,
        component: &str,
        operation: &str,
        result: &str,
        message: &str,
        correlation_id: &str,
        duration_ms: Option<u64>,
    ) {
        self.record(DiagnosticEvent {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            level: level.into(),
            component: component.into(),
            operation: operation.into(),
            result: result.into(),
            message: message.into(),
            correlation_id: correlation_id.into(),
            duration_ms,
            source: None,
            fallback_used: false,
        });
    }

    pub fn report_client(&self, input: ClientDiagnostic) -> Result<(), String> {
        if !matches!(
            normalized_level(&input.level),
            "DEBUG" | "INFO" | "WARN" | "ERROR"
        ) {
            return Err("invalid diagnostic level".into());
        }
        if input.operation.len() > 80 || input.message.len() > 1_000 {
            return Err("client diagnostic exceeds size limit".into());
        }
        self.event(
            &input.level,
            "browser",
            &input.operation,
            if normalized_level(&input.level) == "ERROR" {
                "error"
            } else {
                "reported"
            },
            &input.message,
            input.correlation_id.as_deref().unwrap_or("browser"),
            None,
        );
        Ok(())
    }

    pub fn list(&self, filter: &DiagnosticFilter) -> anyhow::Result<Value> {
        let all_events = self.read_all()?;
        let last_error = all_events
            .iter()
            .filter(|event| event.level == "ERROR")
            .max_by_key(|event| event.timestamp)
            .cloned();
        let mut components: Vec<String> = all_events
            .iter()
            .map(|event| event.component.clone())
            .collect();
        components.sort();
        components.dedup();
        let mut events = all_events;
        let query = filter.query.to_lowercase();
        events.retain(|event| {
            (filter.levels.is_empty()
                || filter
                    .levels
                    .iter()
                    .any(|level| normalized_level(level) == event.level))
                && (filter.components.is_empty()
                    || filter
                        .components
                        .iter()
                        .any(|item| item == &event.component))
                && (query.is_empty()
                    || format!("{} {} {}", event.component, event.operation, event.message)
                        .to_lowercase()
                        .contains(&query))
                && filter.since.is_none_or(|since| event.timestamp >= since)
                && filter.until.is_none_or(|until| event.timestamp <= until)
        });
        events.sort_by_key(|event| std::cmp::Reverse(event.timestamp));
        let total = events.len();
        let offset = filter.cursor.unwrap_or(0).min(total);
        let limit = filter.limit.unwrap_or(200).clamp(1, 500);
        let page: Vec<_> = events.into_iter().skip(offset).take(limit).collect();
        let next_cursor = (offset + page.len() < total).then_some(offset + page.len());
        Ok(json!({
            "events": page,
            "nextCursor": next_cursor,
            "total": total,
            "components": components,
            "summary": {
                "status": "ok",
                "version": env!("CARGO_PKG_VERSION"),
                "uptimeSeconds": self.started_at.elapsed().as_secs(),
                "lastError": last_error
            }
        }))
    }

    pub fn export_bundle(&self) -> anyhow::Result<String> {
        let events = self.read_all()?;
        let manifest = json!({
            "application": "fin-alfred",
            "version": env!("CARGO_PKG_VERSION"),
            "exportedAt": Utc::now(),
            "operatingSystem": std::env::consts::OS,
            "architecture": std::env::consts::ARCH,
            "retentionDays": RETENTION_DAYS,
            "eventCount": events.len()
        });
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut archive = ZipWriter::new(&mut bytes);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            archive.start_file("manifest.json", options)?;
            archive.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
            archive.start_file("logs.ndjson", options)?;
            for event in events {
                writeln!(archive, "{}", serde_json::to_string(&event)?)?;
            }
            archive.start_file("README.txt", options)?;
            archive.write_all(b"This bundle contains sanitized fin-alfred diagnostics only. It excludes profile databases, investment data, credentials, cookies, and tokens.\n")?;
            archive.finish()?;
        }
        Ok(URL_SAFE_NO_PAD.encode(bytes.into_inner()))
    }

    fn read_all(&self) -> anyhow::Result<Vec<DiagnosticEvent>> {
        let mut events = Vec::new();
        for path in log_files(&self.directory)? {
            let content = fs::read_to_string(path).unwrap_or_default();
            events.extend(
                content
                    .lines()
                    .filter_map(|line| serde_json::from_str::<DiagnosticEvent>(line).ok()),
            );
        }
        Ok(events)
    }

    fn prune(&self) -> anyhow::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("diagnostic lock poisoned"))?;
        self.prune_locked()
    }

    fn prune_locked(&self) -> anyhow::Result<()> {
        let cutoff = Utc::now().date_naive() - Duration::days(RETENTION_DAYS - 1);
        let mut files = log_files(&self.directory)?;
        for path in &files {
            if log_date(path).is_some_and(|date| date < cutoff) {
                let _ = fs::remove_file(path);
            }
        }
        files = log_files(&self.directory)?;
        let mut total: u64 = files
            .iter()
            .filter_map(|path| fs::metadata(path).ok().map(|meta| meta.len()))
            .sum();
        for path in files {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if let Ok(meta) = fs::metadata(&path) {
                if fs::remove_file(&path).is_ok() {
                    total = total.saturating_sub(meta.len());
                }
            }
        }
        Ok(())
    }
}

fn log_files(directory: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files: Vec<_> = fs::read_dir(directory)
        .with_context(|| format!("read diagnostics directory {}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|value| value == "ndjson"))
        .collect();
    files.sort();
    Ok(files)
}

fn log_date(path: &Path) -> Option<NaiveDate> {
    let name = path.file_stem()?.to_str()?;
    NaiveDate::parse_from_str(name.strip_prefix("fin-alfred-")?, "%Y-%m-%d").ok()
}

fn level_value(level: &str) -> Option<u8> {
    match normalized_level(level) {
        "DEBUG" => Some(0),
        "INFO" => Some(1),
        "WARN" => Some(2),
        "ERROR" => Some(3),
        _ => None,
    }
}

fn normalized_level(level: &str) -> &'static str {
    if level.eq_ignore_ascii_case("DEBUG") {
        "DEBUG"
    } else if level.eq_ignore_ascii_case("WARN") || level.eq_ignore_ascii_case("WARNING") {
        "WARN"
    } else if level.eq_ignore_ascii_case("ERROR") {
        "ERROR"
    } else {
        "INFO"
    }
}

fn safe_label(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || "-_.:/ ".contains(*character))
        .take(limit)
        .collect()
}

fn redact(message: &str, log_directory: &Path) -> String {
    let mut output = message.replace('\\', "/");
    if let Some(data_directory) = log_directory.parent() {
        output = output.replace(
            &data_directory.to_string_lossy().replace('\\', "/"),
            "<data-dir>",
        );
    }
    if let Some(home) = dirs::home_dir() {
        output = output.replace(&home.to_string_lossy().replace('\\', "/"), "<home>");
    }
    for marker in [
        "token",
        "password",
        "secret",
        "cookie",
        "api_key",
        "apikey",
        "bearer",
        "cash=",
        "cash:",
        "quantity=",
        "quantity:",
        "price=",
        "price:",
        "amount=",
        "amount:",
    ] {
        output = redact_after_marker(&output, marker);
    }
    output
        .split_whitespace()
        .map(|word| {
            if word.starts_with("profile-") {
                "<profile>"
            } else if word.starts_with("HKEX:") {
                "<instrument>"
            } else if is_windows_absolute_path(word) {
                "<local-path>"
            } else {
                word
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect()
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn redact_after_marker(input: &str, marker: &str) -> String {
    let mut output = input.to_string();
    let mut offset = 0_usize;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative) = lower[offset..].find(marker) else {
            break;
        };
        let start = offset + relative + marker.len();
        let suffix = &output[start..];
        let skip = suffix
            .chars()
            .take_while(|c| c.is_whitespace() || ":=\"'".contains(*c))
            .count();
        let value_start = start + skip;
        let length = output[value_start..]
            .chars()
            .take_while(|c| !c.is_whitespace() && !",;)}]".contains(*c))
            .map(char::len_utf8)
            .sum::<usize>();
        if length > 0 {
            output.replace_range(value_start..value_start + length, "<redacted>");
            offset = value_start + "<redacted>".len();
        } else {
            offset = start.max(offset + 1);
        }
        if offset >= output.len() {
            break;
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn redacts_sensitive_values_and_paths() {
        let directory = tempdir().unwrap();
        let logs = directory.path().join("logs");
        let value = redact(
            &format!(
                "token=abc password: xyz cash=395000 price:25.68 profile-private HKEX:1810 D:\\private\\file.txt {}",
                directory.path().display()
            ),
            &logs,
        );
        assert!(!value.contains("abc"));
        assert!(!value.contains("xyz"));
        assert!(!value.contains("395000"));
        assert!(!value.contains("25.68"));
        assert!(!value.contains("profile-private"));
        assert!(!value.contains("HKEX:1810"));
        assert!(!value.contains("D:/private"));
        assert!(value.contains("<local-path>"));
        assert!(value.contains("<data-dir>"));
    }

    #[test]
    fn list_filters_and_skips_corrupt_lines() {
        let directory = tempdir().unwrap();
        let store = DiagnosticStore::open(directory.path()).unwrap();
        store.event(
            "ERROR",
            "akshare",
            "prices",
            "error",
            "network unavailable",
            "one",
            Some(25),
        );
        let path = store.directory.join(format!(
            "fin-alfred-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(b"not-json\n")
            .unwrap();
        let result = store
            .list(&DiagnosticFilter {
                levels: vec!["ERROR".into()],
                query: "network".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result["total"], 1);
    }

    #[test]
    fn startup_prunes_expired_and_oversized_logs() {
        let directory = tempdir().unwrap();
        let logs = directory.path().join("logs");
        fs::create_dir_all(&logs).unwrap();
        let expired = logs.join(format!(
            "fin-alfred-{}.ndjson",
            (Utc::now().date_naive() - Duration::days(8)).format("%Y-%m-%d")
        ));
        fs::write(&expired, b"expired\n").unwrap();
        let oversized = logs.join(format!(
            "fin-alfred-{}.ndjson",
            (Utc::now().date_naive() - Duration::days(1)).format("%Y-%m-%d")
        ));
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_TOTAL_BYTES + 1)
            .unwrap();
        let current = logs.join(format!(
            "fin-alfred-{}.ndjson",
            Utc::now().format("%Y-%m-%d")
        ));
        fs::write(&current, b"current\n").unwrap();

        let _store = DiagnosticStore::open(directory.path()).unwrap();

        assert!(!expired.exists());
        assert!(!oversized.exists());
        assert!(current.exists());
    }

    #[test]
    fn exported_bundle_excludes_database_content() {
        let directory = tempdir().unwrap();
        let store = DiagnosticStore::open(directory.path()).unwrap();
        store.event("INFO", "gateway", "startup", "ok", "ready", "startup", None);
        let encoded = store.export_bundle().unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("manifest.json").is_ok());
        assert!(archive.by_name("logs.ndjson").is_ok());
        assert!(archive.by_name("profiles.catalog.db").is_err());
    }
}

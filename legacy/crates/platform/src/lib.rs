use anyhow::Context;
use rand::RngCore;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

mod backup;
pub use backup::*;

pub trait SecretStore: Send + Sync {
    fn put(&self, key: &str, secret: &[u8]) -> anyhow::Result<()>;
    fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>>;
    fn delete(&self, key: &str) -> anyhow::Result<()>;
}

pub trait AppDataDirectory: Send + Sync {
    fn app_data_directory(&self) -> anyhow::Result<PathBuf>;
}

pub trait FileDialog: Send + Sync {
    fn choose_open_file(&self) -> anyhow::Result<Option<PathBuf>>;
    fn choose_save_file(&self, suggested_name: &str) -> anyhow::Result<Option<PathBuf>>;
}

pub trait NotificationService: Send + Sync {
    fn notify(&self, title: &str, body: &str) -> anyhow::Result<()>;
}

pub trait ExternalUrlOpener: Send + Sync {
    fn open_https_url(&self, url: &str) -> anyhow::Result<()>;
}

pub trait ClipboardService: Send + Sync {
    fn write_text(&self, value: &str) -> anyhow::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformInfo {
    pub operating_system: String,
    pub architecture: String,
}

pub trait PlatformInfoProvider: Send + Sync {
    fn platform_info(&self) -> PlatformInfo;
}

#[derive(Default)]
pub struct InMemoryPlatformAdapter {
    pub app_data: PathBuf,
    clipboard: Mutex<String>,
    notifications: Mutex<Vec<(String, String)>>,
}

impl AppDataDirectory for InMemoryPlatformAdapter {
    fn app_data_directory(&self) -> anyhow::Result<PathBuf> {
        Ok(self.app_data.clone())
    }
}
impl ClipboardService for InMemoryPlatformAdapter {
    fn write_text(&self, value: &str) -> anyhow::Result<()> {
        *self.clipboard.lock().unwrap() = value.into();
        Ok(())
    }
}
impl NotificationService for InMemoryPlatformAdapter {
    fn notify(&self, title: &str, body: &str) -> anyhow::Result<()> {
        self.notifications
            .lock()
            .unwrap()
            .push((title.into(), body.into()));
        Ok(())
    }
}
impl PlatformInfoProvider for InMemoryPlatformAdapter {
    fn platform_info(&self) -> PlatformInfo {
        PlatformInfo {
            operating_system: "test".into(),
            architecture: "memory".into(),
        }
    }
}

pub struct SystemSecretStore {
    service: String,
}

impl SystemSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }
}

impl SecretStore for SystemSecretStore {
    fn put(&self, key: &str, secret: &[u8]) -> anyhow::Result<()> {
        keyring::Entry::new(&self.service, key)?
            .set_secret(secret)
            .context("store secret")
    }
    fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        match keyring::Entry::new(&self.service, key)?.get_secret() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("read secret"),
        }
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        match keyring::Entry::new(&self.service, key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("delete secret"),
        }
    }
}

#[derive(Default)]
pub struct InMemorySecretStore {
    values: Mutex<HashMap<String, Vec<u8>>>,
}

impl SecretStore for InMemorySecretStore {
    fn put(&self, key: &str, secret: &[u8]) -> anyhow::Result<()> {
        self.values
            .lock()
            .unwrap()
            .insert(key.into(), secret.into());
        Ok(())
    }
    fn get(&self, key: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self.values.lock().unwrap().get(key).cloned())
    }
    fn delete(&self, key: &str) -> anyhow::Result<()> {
        self.values.lock().unwrap().remove(key);
        Ok(())
    }
}

pub fn generate_database_key() -> [u8; 32] {
    let mut key = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_secret_store_round_trip() {
        let store = InMemorySecretStore::default();
        store.put("profile", b"secret").unwrap();
        assert_eq!(store.get("profile").unwrap(), Some(b"secret".to_vec()));
        store.delete("profile").unwrap();
        assert_eq!(store.get("profile").unwrap(), None);
    }
}

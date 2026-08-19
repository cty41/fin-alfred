use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use thiserror::Error;

const FORMAT: &str = "fin-alfred-backup";
const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupEnvelope {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub app_version: String,
    pub payload_sha256: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BackupError {
    #[error("invalid backup format")]
    InvalidFormat,
    #[error("backup password is incorrect or the file is damaged")]
    DecryptionFailed,
    #[error("backup serialization failed")]
    Serialization,
    #[error("backup schema is newer than this application supports")]
    UnsupportedSchema,
    #[error("restore target already exists")]
    TargetExists,
    #[error("restored profile failed validation")]
    ValidationFailed,
    #[error("backup file operation failed")]
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableProfilePayload {
    pub profile_id: String,
    #[serde(default)]
    pub profile_name: String,
    pub database_sha256: String,
    pub database: String,
}

fn derive_key(password: &[u8], salt: &[u8]) -> Result<[u8; 32], BackupError> {
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(password, salt, &mut key)
        .map_err(|_| BackupError::DecryptionFailed)?;
    Ok(key)
}

pub fn encrypt_backup(
    payload: &[u8],
    password: &str,
    schema_version: u32,
    app_version: &str,
) -> Result<Vec<u8>, BackupError> {
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    let key = derive_key(password.as_bytes(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| BackupError::DecryptionFailed)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), payload)
        .map_err(|_| BackupError::DecryptionFailed)?;
    let envelope = BackupEnvelope {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        schema_version,
        app_version: app_version.into(),
        payload_sha256: hex::encode(Sha256::digest(payload)),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    };
    serde_json::to_vec_pretty(&envelope).map_err(|_| BackupError::Serialization)
}

pub fn decrypt_backup(
    serialized: &[u8],
    password: &str,
) -> Result<(BackupEnvelope, Vec<u8>), BackupError> {
    let envelope: BackupEnvelope =
        serde_json::from_slice(serialized).map_err(|_| BackupError::InvalidFormat)?;
    if envelope.format != FORMAT || envelope.format_version != FORMAT_VERSION {
        return Err(BackupError::InvalidFormat);
    }
    let salt = STANDARD
        .decode(&envelope.salt)
        .map_err(|_| BackupError::InvalidFormat)?;
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| BackupError::InvalidFormat)?;
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| BackupError::InvalidFormat)?;
    if nonce.len() != 12 {
        return Err(BackupError::InvalidFormat);
    }
    let key = derive_key(password.as_bytes(), &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| BackupError::DecryptionFailed)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| BackupError::DecryptionFailed)?;
    if hex::encode(Sha256::digest(&plaintext)) != envelope.payload_sha256 {
        return Err(BackupError::DecryptionFailed);
    }
    Ok((envelope, plaintext))
}

pub fn create_profile_backup(
    profile_id: &str,
    profile_name: &str,
    database: &[u8],
    password: &str,
    schema_version: u32,
    app_version: &str,
) -> Result<Vec<u8>, BackupError> {
    let payload = PortableProfilePayload {
        profile_id: profile_id.into(),
        profile_name: profile_name.into(),
        database_sha256: hex::encode(Sha256::digest(database)),
        database: STANDARD.encode(database),
    };
    let serialized = serde_json::to_vec(&payload).map_err(|_| BackupError::Serialization)?;
    encrypt_backup(&serialized, password, schema_version, app_version)
}

pub fn decode_profile_backup(
    backup: &[u8],
    password: &str,
    maximum_schema_version: u32,
) -> Result<(BackupEnvelope, PortableProfilePayload, Vec<u8>), BackupError> {
    let (envelope, plaintext) = decrypt_backup(backup, password)?;
    if envelope.schema_version > maximum_schema_version {
        return Err(BackupError::UnsupportedSchema);
    }
    let payload: PortableProfilePayload =
        serde_json::from_slice(&plaintext).map_err(|_| BackupError::InvalidFormat)?;
    let database = STANDARD
        .decode(&payload.database)
        .map_err(|_| BackupError::InvalidFormat)?;
    if hex::encode(Sha256::digest(&database)) != payload.database_sha256 {
        return Err(BackupError::DecryptionFailed);
    }
    Ok((envelope, payload, database))
}

pub fn restore_profile_backup_to_new_file<F>(
    backup: &[u8],
    password: &str,
    maximum_schema_version: u32,
    target: &Path,
    validate: F,
) -> Result<PortableProfilePayload, BackupError>
where
    F: FnOnce(&Path) -> bool,
{
    if target.exists() {
        return Err(BackupError::TargetExists);
    }
    let (_, payload, database) = decode_profile_backup(backup, password, maximum_schema_version)?;
    let parent = target.parent().ok_or(BackupError::Io)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| BackupError::Io)?;
    temporary
        .write_all(&database)
        .map_err(|_| BackupError::Io)?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| BackupError::Io)?;
    if !validate(temporary.path()) {
        return Err(BackupError::ValidationFailed);
    }
    temporary.persist_noclobber(target).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            BackupError::TargetExists
        } else {
            BackupError::Io
        }
    })?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_backup_round_trip_and_wrong_password_rejection() {
        let encrypted = encrypt_backup(b"portable-profile", "correct horse", 1, "0.1.0").unwrap();
        let (envelope, plaintext) = decrypt_backup(&encrypted, "correct horse").unwrap();
        assert_eq!(envelope.schema_version, 1);
        assert_eq!(plaintext, b"portable-profile");
        assert_eq!(
            decrypt_backup(&encrypted, "wrong"),
            Err(BackupError::DecryptionFailed)
        );
    }

    #[test]
    fn restore_validates_before_publish_and_never_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("profile.db");
        let backup =
            create_profile_backup("p", "档案", b"encrypted-database", "password", 1, "0.1.0")
                .unwrap();
        let restored =
            restore_profile_backup_to_new_file(&backup, "password", 1, &target, |path| {
                std::fs::read(path).unwrap() == b"encrypted-database"
            })
            .unwrap();
        assert_eq!(restored.profile_id, "p");
        assert_eq!(std::fs::read(&target).unwrap(), b"encrypted-database");
        assert_eq!(
            restore_profile_backup_to_new_file(&backup, "password", 1, &target, |_| true),
            Err(BackupError::TargetExists)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"encrypted-database");
    }

    #[test]
    fn failed_validation_leaves_no_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("profile.db");
        let backup = create_profile_backup("p", "档案", b"bad-db", "password", 1, "0.1.0").unwrap();
        assert_eq!(
            restore_profile_backup_to_new_file(&backup, "password", 1, &target, |_| false),
            Err(BackupError::ValidationFailed)
        );
        assert!(!target.exists());
    }

    #[test]
    fn damaged_and_newer_schema_backups_are_rejected_before_restore() {
        let backup =
            create_profile_backup("p", "档案", b"portable-db", "password", 3, "0.3.0").unwrap();
        assert_eq!(
            decode_profile_backup(&backup, "password", 2),
            Err(BackupError::UnsupportedSchema)
        );
        let mut damaged: serde_json::Value = serde_json::from_slice(&backup).unwrap();
        damaged["ciphertext"] = serde_json::Value::String("not-valid-base64***".into());
        assert_eq!(
            decode_profile_backup(&serde_json::to_vec(&damaged).unwrap(), "password", 3),
            Err(BackupError::InvalidFormat)
        );
    }
}

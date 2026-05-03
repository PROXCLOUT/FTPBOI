use argon2::Argon2;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use crate::connection_manager::ConnectionProtocol;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MasterStatus {
    pub enabled: bool,
    pub configured: bool,
    pub unlocked: bool,
    pub failed_attempts: u8,
    pub cooldown_until_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MasterConfig {
    enabled: bool,
    salt_b64: Option<String>,
    verifier_b64: Option<String>,
}

#[derive(Debug)]
struct SessionState {
    unlocked: bool,
    master_key: Option<[u8; 32]>,
    failed_attempts: u8,
    cooldown_until_unix_ms: Option<u64>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            unlocked: false,
            master_key: None,
            failed_attempts: 0,
            cooldown_until_unix_ms: None,
        }
    }
}

static SESSION: OnceLock<Mutex<SessionState>> = OnceLock::new();

fn session() -> &'static Mutex<SessionState> {
    SESSION.get_or_init(|| Mutex::new(SessionState::default()))
}

fn now_unix_ms() -> u64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".fz-next").join("master.json"))
}

fn encrypted_db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".fz-next").join("secure-connections.bin"))
}

fn load_config() -> Result<MasterConfig, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(MasterConfig {
            enabled: false,
            salt_b64: None,
            verifier_b64: None,
        });
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_config(cfg: &MasterConfig) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn build_verifier(key: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update(b"fz-next-master-verifier");
    hasher.finalize().into()
}

pub fn status() -> Result<MasterStatus, String> {
    let cfg = load_config()?;
    let lock = session().lock().expect("master session mutex poisoned");
    Ok(MasterStatus {
        enabled: cfg.enabled,
        configured: cfg.salt_b64.is_some() && cfg.verifier_b64.is_some(),
        unlocked: lock.unlocked,
        failed_attempts: lock.failed_attempts,
        cooldown_until_unix_ms: lock.cooldown_until_unix_ms,
    })
}

pub fn setup_master_password(password: &str) -> Result<MasterStatus, String> {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let key = derive_key(password, &salt)?;
    let verifier = build_verifier(&key);
    let cfg = MasterConfig {
        enabled: true,
        salt_b64: Some(BASE64.encode(salt)),
        verifier_b64: Some(BASE64.encode(verifier)),
    };
    save_config(&cfg)?;
    {
        let mut lock = session().lock().expect("master session mutex poisoned");
        lock.unlocked = true;
        lock.master_key = Some(key);
        lock.failed_attempts = 0;
        lock.cooldown_until_unix_ms = None;
    }
    status()
}

pub fn set_enabled(enabled: bool) -> Result<MasterStatus, String> {
    let mut cfg = load_config()?;
    cfg.enabled = enabled;
    save_config(&cfg)?;
    status()
}

pub fn unlock(password: &str) -> Result<MasterStatus, String> {
    let cfg = load_config()?;
    let salt = cfg
        .salt_b64
        .ok_or_else(|| "master passwort nicht konfiguriert".to_string())
        .and_then(|v| BASE64.decode(v).map_err(|e| e.to_string()))?;
    let verifier_expected = cfg
        .verifier_b64
        .ok_or_else(|| "master passwort nicht konfiguriert".to_string())
        .and_then(|v| BASE64.decode(v).map_err(|e| e.to_string()))?;
    let mut lock = session().lock().expect("master session mutex poisoned");
    if let Some(until) = lock.cooldown_until_unix_ms {
        if now_unix_ms() < until {
            return Err("cooldown aktiv".to_string());
        }
        lock.cooldown_until_unix_ms = None;
    }
    let key = derive_key(password, &salt)?;
    let verifier = build_verifier(&key);
    if verifier_expected != verifier {
        lock.failed_attempts = lock.failed_attempts.saturating_add(1);
        if lock.failed_attempts >= 3 {
            lock.cooldown_until_unix_ms = Some(now_unix_ms() + 5_000);
            lock.failed_attempts = 0;
        }
        return Err("falsches masterpasswort".to_string());
    }
    lock.unlocked = true;
    lock.master_key = Some(key);
    lock.failed_attempts = 0;
    lock.cooldown_until_unix_ms = None;
    drop(lock);
    status()
}

pub fn lock_session() {
    let mut lock = session().lock().expect("master session mutex poisoned");
    lock.unlocked = false;
    lock.master_key = None;
}

pub fn change_password(current: &str, next: &str) -> Result<MasterStatus, String> {
    unlock(current)?;
    setup_master_password(next)
}

pub fn reset_all() -> Result<MasterStatus, String> {
    let cfg = MasterConfig {
        enabled: false,
        salt_b64: None,
        verifier_b64: None,
    };
    save_config(&cfg)?;
    if let Ok(path) = encrypted_db_path() {
        let _ = fs::remove_file(path);
    }
    lock_session();
    status()
}

const SECURE_DB_PAYLOAD_VERSION: u8 = 1;
const SECURE_DB_NONCE_LEN: usize = 12; // AES-GCM standard nonce size

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecureConnectionRecord {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub protocol: ConnectionProtocol,
    pub private_key_path: Option<String>,
    pub public_key_path: Option<String>,
    pub trust_persistently: bool,
    pub accepted_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecureConnectionsDbV1 {
    records: Vec<SecureConnectionRecord>,
}

pub fn encrypt_payload(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; SECURE_DB_NONCE_LEN];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| e.to_string())?;

    // Format: version || nonce(12) || ciphertext+tag
    let mut out = Vec::with_capacity(1 + SECURE_DB_NONCE_LEN + ciphertext.len());
    out.push(SECURE_DB_PAYLOAD_VERSION);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt_payload(ciphertext_with_header: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if ciphertext_with_header.len() < 1 + SECURE_DB_NONCE_LEN {
        return Err("secure db payload zu kurz".to_string());
    }
    let version = ciphertext_with_header[0];
    if version != SECURE_DB_PAYLOAD_VERSION {
        return Err(format!("secure db payload version nicht unterstuetzt: {version}"));
    }

    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce_bytes = &ciphertext_with_header[1..1 + SECURE_DB_NONCE_LEN];
    let ciphertext = &ciphertext_with_header[1 + SECURE_DB_NONCE_LEN..];
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|e| e.to_string())?;
    Ok(plaintext)
}

fn hardware_id_fallback() -> Result<String, String> {
    // Best-effort, ohne extra Crates.
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(start) = stdout.find("IOPlatformUUID") {
            let after = &stdout[start..];
            if let Some(q1_rel) = after.find('"') {
                let after_q1 = &after[(q1_rel + 1)..];
                if let Some(q2_rel) = after_q1.find('"') {
                    let id = after_q1[..q2_rel].trim().to_string();
                    if !id.is_empty() {
                        return Ok(id);
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(raw) = fs::read_to_string("/etc/machine-id") {
            let id = raw.trim().to_string();
            if !id.is_empty() {
                return Ok(id);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wmic")
            .args(["csproduct", "get", "uuid"])
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.eq_ignore_ascii_case("UUID") {
                continue;
            }
            return Ok(trimmed.to_string());
        }
    }

    // Letzter Fallback: Hostname (nicht perfekt, aber device-specific enough for our purpose).
    Ok(std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-device".to_string()))
}

fn derive_hardware_key() -> Result<[u8; 32], String> {
    let hw_id = hardware_id_fallback()?;
    let mut hasher = Sha256::new();
    hasher.update(hw_id.as_bytes());
    Ok(hasher.finalize().into())
}

fn storage_key() -> Result<[u8; 32], String> {
    let cfg = load_config()?;
    let configured = cfg.salt_b64.is_some() && cfg.verifier_b64.is_some();
    if cfg.enabled && configured {
        let lock = session().lock().expect("master session mutex poisoned");
        return lock
            .master_key
            .ok_or_else(|| "master passwort nicht entsperrt".to_string());
    }
    derive_hardware_key()
}

pub fn load_secure_connections_records() -> Result<Vec<SecureConnectionRecord>, String> {
    let path = encrypted_db_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let key = storage_key()?;
    let plaintext = decrypt_payload(&raw, &key)?;
    let db: SecureConnectionsDbV1 = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    Ok(db.records)
}

pub fn save_secure_connections_records(records: &[SecureConnectionRecord]) -> Result<(), String> {
    let key = storage_key()?;
    let db = SecureConnectionsDbV1 {
        records: records.to_vec(),
    };
    let plaintext = serde_json::to_vec(&db).map_err(|e| e.to_string())?;
    let encrypted = encrypt_payload(&plaintext, &key)?;
    let path = encrypted_db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, encrypted).map_err(|e| e.to_string())?;
    Ok(())
}

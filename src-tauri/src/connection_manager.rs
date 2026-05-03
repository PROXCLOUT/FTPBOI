use crate::vault;
use crate::master_vault;
use crate::trust_store::{self, TrustRecord};
use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use suppaftp::native_tls::TlsConnector;
use suppaftp::{FtpError, FtpStream, NativeTlsConnector, NativeTlsFtpStream};
use uuid::Uuid;
use ssh2::{Session, Sftp};
use sha2::{Digest, Sha256};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionProtocol {
    Sftp,
    Ftp,
    Ftps,
}

impl Default for ConnectionProtocol {
    fn default() -> Self {
        Self::Sftp
    }
}

impl Display for ConnectionProtocol {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sftp => write!(f, "sftp"),
            Self::Ftp => write!(f, "ftp"),
            Self::Ftps => write!(f, "ftps"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectionInfo {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub protocol: ConnectionProtocol,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConnectPayload {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub protocol: ConnectionProtocol,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub public_key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub trust_persistently: bool,
    pub accepted_fingerprint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SecurityEvent {
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub protocol: String,
    pub fingerprint: Option<String>,
    pub expected_fingerprint: Option<String>,
    pub issuer: Option<String>,
    pub valid_from: Option<String>,
    pub valid_to: Option<String>,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error("host darf nicht leer sein")]
    EmptyHost,
    #[error("username darf nicht leer sein")]
    EmptyUsername,
    #[error("connection nicht gefunden: {0}")]
    UnknownConnection(String),
    #[error("ssh Fehler: {0}")]
    Ssh(#[from] ssh2::Error),
    #[error("tcp Fehler: {0}")]
    Tcp(#[from] std::io::Error),
    #[error("auth fehlgeschlagen")]
    AuthFailed,
    #[error("kein Passwort gefunden")]
    MissingPassword,
    #[error("auth konnte nicht verifiziert werden")]
    AuthUnavailable,
    #[error("vault Fehler: {0}")]
    Vault(String),
    #[error("ftp Fehler: {0}")]
    Ftp(String),
    #[error("ungueltiges ftps setup: {0}")]
    FtpsSetup(String),
    #[error("{0}")]
    Security(String),
}

pub enum FtpConnection {
    Plain(FtpStream),
    Secure(NativeTlsFtpStream),
}

impl FtpConnection {
    fn verbose_ftp_enabled() -> bool {
        std::env::var("FTPBOI_VERBOSE_FTP")
            .ok()
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "1" || normalized == "true" || normalized == "yes" || normalized == "on"
            })
            .unwrap_or(false)
    }

    fn log_ftp_command_start(command: &str, target: &str) -> Option<Instant> {
        if !Self::verbose_ftp_enabled() {
            return None;
        }
        let started = Instant::now();
        println!(
            "[FTPBOI][FTP-CMD] phase=start command={} target={}",
            command, target
        );
        Some(started)
    }

    fn log_ftp_command_end(command: &str, target: &str, started: Option<Instant>, error: Option<&FtpError>) {
        let Some(started) = started else {
            return;
        };
        let elapsed_ms = started.elapsed().as_millis();
        match error {
            None => println!(
                "[FTPBOI][FTP-CMD] phase=end command={} target={} status=ok elapsed_ms={}",
                command, target, elapsed_ms
            ),
            Some(error) => eprintln!(
                "[FTPBOI][FTP-CMD] phase=end command={} target={} status=error elapsed_ms={} error={}",
                command, target, elapsed_ms, error
            ),
        }
    }

    pub fn cwd(&mut self, path: &str) -> Result<(), FtpError> {
        let started = Self::log_ftp_command_start("CWD", path);
        let result = match self {
            Self::Plain(stream) => stream.cwd(path),
            Self::Secure(stream) => stream.cwd(path),
        };
        Self::log_ftp_command_end("CWD", path, started, result.as_ref().err());
        result
    }

    pub fn pwd(&mut self) -> Result<String, FtpError> {
        let started = Self::log_ftp_command_start("PWD", ".");
        let result = match self {
            Self::Plain(stream) => stream.pwd(),
            Self::Secure(stream) => stream.pwd(),
        };
        Self::log_ftp_command_end("PWD", ".", started, result.as_ref().err());
        result
    }

    pub fn list(&mut self, path: Option<&str>) -> Result<Vec<String>, FtpError> {
        match self {
            Self::Plain(stream) => stream.list(path),
            Self::Secure(stream) => stream.list(path),
        }
    }

    pub fn mlsd(&mut self, path: Option<&str>) -> Result<Vec<String>, FtpError> {
        match self {
            Self::Plain(stream) => stream.mlsd(path),
            Self::Secure(stream) => stream.mlsd(path),
        }
    }

    pub fn mdtm(&mut self, path: &str) -> Result<String, FtpError> {
        match self {
            Self::Plain(stream) => stream.mdtm(path).map(|value| value.to_string()),
            Self::Secure(stream) => stream.mdtm(path).map(|value| value.to_string()),
        }
    }

    pub fn size(&mut self, path: &str) -> Result<u64, FtpError> {
        match self {
            Self::Plain(stream) => stream.size(path).map(|value| value as u64),
            Self::Secure(stream) => stream.size(path).map(|value| value as u64),
        }
    }

    pub fn retr_as_buffer(&mut self, remote_file: &str) -> Result<std::io::Cursor<Vec<u8>>, FtpError> {
        let started = Self::log_ftp_command_start("RETR", remote_file);
        match self {
            Self::Plain(stream) => {
                let result = stream.retr_as_buffer(remote_file);
                Self::log_ftp_command_end("RETR", remote_file, started, result.as_ref().err());
                result
            }
            Self::Secure(stream) => {
                let result = stream.retr_as_buffer(remote_file);
                Self::log_ftp_command_end("RETR", remote_file, started, result.as_ref().err());
                result
            }
        }
    }

    pub fn put_file(&mut self, filename: &str, reader: &mut impl Read) -> Result<u64, FtpError> {
        let started = Self::log_ftp_command_start("STOR", filename);
        let result = match self {
            Self::Plain(stream) => stream.put_file(filename, reader),
            Self::Secure(stream) => stream.put_file(filename, reader),
        };
        Self::log_ftp_command_end("STOR", filename, started, result.as_ref().err());
        result
    }

    pub fn mkdir(&mut self, path: &str) -> Result<(), FtpError> {
        let started = Self::log_ftp_command_start("MKD", path);
        let result = match self {
            Self::Plain(stream) => stream.mkdir(path),
            Self::Secure(stream) => stream.mkdir(path),
        };
        Self::log_ftp_command_end("MKD", path, started, result.as_ref().err());
        result
    }

    pub fn quit(&mut self) -> Result<(), FtpError> {
        match self {
            Self::Plain(stream) => stream.quit(),
            Self::Secure(stream) => stream.quit(),
        }
    }

    pub fn rename<S: AsRef<str>>(&mut self, from_name: S, to_name: S) -> Result<(), FtpError> {
        match self {
            Self::Plain(stream) => stream.rename(from_name, to_name),
            Self::Secure(stream) => stream.rename(from_name, to_name),
        }
    }

    pub fn rm<S: AsRef<str>>(&mut self, filename: S) -> Result<(), FtpError> {
        match self {
            Self::Plain(stream) => stream.rm(filename),
            Self::Secure(stream) => stream.rm(filename),
        }
    }

    pub fn rmdir<S: AsRef<str>>(&mut self, pathname: S) -> Result<(), FtpError> {
        match self {
            Self::Plain(stream) => stream.rmdir(pathname),
            Self::Secure(stream) => stream.rmdir(pathname),
        }
    }
}

static CONNECTIONS: OnceLock<Mutex<Vec<ConnectionInfo>>> = OnceLock::new();
static CONNECTION_PAYLOADS: OnceLock<Mutex<HashMap<String, ConnectPayload>>> = OnceLock::new();
static SESSION_CACHE: OnceLock<Mutex<HashMap<String, SessionMeta>>> = OnceLock::new();
static SFTP_POOL: OnceLock<Mutex<HashMap<String, VecDeque<PooledSftp>>>> = OnceLock::new();
static FTP_POOL: OnceLock<Mutex<HashMap<String, VecDeque<PooledFtp>>>> = OnceLock::new();
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const POOL_MAX_SIZE: usize = 4;

#[derive(Debug, Clone)]
struct SessionMeta {
    last_used: Instant,
    verified_dirs: HashSet<String>,
}

struct PooledSftp {
    _session: Session,
    sftp: Sftp,
    last_used: Instant,
}

struct PooledFtp {
    connection: FtpConnection,
    last_used: Instant,
}

fn connection_store() -> &'static Mutex<Vec<ConnectionInfo>> {
    CONNECTIONS.get_or_init(|| Mutex::new(Vec::new()))
}

fn session_store() -> &'static Mutex<HashMap<String, SessionMeta>> {
    SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn payload_store() -> &'static Mutex<HashMap<String, ConnectPayload>> {
    CONNECTION_PAYLOADS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn persist_secure_connections_db() {
    let connections = connection_store()
        .lock()
        .expect("connection mutex poisoned")
        .clone();
    let payloads = payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .clone();

    let records: Vec<master_vault::SecureConnectionRecord> = connections
        .iter()
        .filter_map(|conn| {
            let payload = payloads.get(&conn.id)?;
            Some(master_vault::SecureConnectionRecord {
                id: conn.id.clone(),
                host: conn.host.clone(),
                port: conn.port,
                username: conn.username.clone(),
                protocol: conn.protocol.clone(),
                private_key_path: payload.private_key_path.clone(),
                public_key_path: payload.public_key_path.clone(),
                trust_persistently: payload.trust_persistently,
                accepted_fingerprint: payload.accepted_fingerprint.clone(),
            })
        })
        .collect();

    if let Err(error) = master_vault::save_secure_connections_records(&records) {
        // Persistieren ist für die Funktionalität nicht zwingend (z.B. wenn Master Key gesperrt ist),
        // aber wir loggen es zur Diagnose.
        eprintln!("[FTPBOI][BE] secure-connections.bin save failed: {error}");
    }
}

fn sftp_pool_store() -> &'static Mutex<HashMap<String, VecDeque<PooledSftp>>> {
    SFTP_POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn ftp_pool_store() -> &'static Mutex<HashMap<String, VecDeque<PooledFtp>>> {
    FTP_POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_stale_sessions() {
    let now = Instant::now();
    session_store()
        .lock()
        .expect("session mutex poisoned")
        .retain(|_, meta| now.duration_since(meta.last_used) < SESSION_TTL);
    sftp_pool_store()
        .lock()
        .expect("sftp pool mutex poisoned")
        .retain(|_, pool| {
            pool.retain(|entry| now.duration_since(entry.last_used) < SESSION_TTL);
            !pool.is_empty()
        });
    ftp_pool_store()
        .lock()
        .expect("ftp pool mutex poisoned")
        .retain(|_, pool| {
            pool.retain(|entry| now.duration_since(entry.last_used) < SESSION_TTL);
            !pool.is_empty()
        });
}

pub fn list_connections() -> Vec<ConnectionInfo> {
    cleanup_stale_sessions();
    let lock = connection_store().lock().expect("connection mutex poisoned");
    lock.iter()
        .filter(|item| {
            session_store()
                .lock()
                .expect("session mutex poisoned")
                .contains_key(&item.id)
        })
        .cloned()
        .collect()
}

pub fn rehydrate_secure_connections() -> Result<(), String> {
    let records = master_vault::load_secure_connections_records().map_err(|e| e.to_string())?;
    if records.is_empty() {
        return Ok(());
    }

    let now = Instant::now();

    let mut connections = connection_store()
        .lock()
        .map_err(|_| "connection mutex poisoned".to_string())?;
    let mut payloads = payload_store()
        .lock()
        .map_err(|_| "payload mutex poisoned".to_string())?;
    let mut sessions = session_store()
        .lock()
        .map_err(|_| "session mutex poisoned".to_string())?;

    for rec in records {
        // Connection-Metadaten updaten/hochziehen.
        if let Some(existing) = connections.iter_mut().find(|c| c.id == rec.id) {
            existing.host = rec.host.clone();
            existing.port = rec.port;
            existing.username = rec.username.clone();
            existing.protocol = rec.protocol.clone();
        } else {
            connections.push(ConnectionInfo {
                id: rec.id.clone(),
                host: rec.host.clone(),
                port: rec.port,
                username: rec.username.clone(),
                protocol: rec.protocol.clone(),
            });
        }

        // ConnectPayload neu erzeugen (Passwort bleibt in OS Keyring, wird hier bewusst nicht persistiert).
        payloads.insert(
            rec.id.clone(),
            ConnectPayload {
                host: rec.host,
                port: rec.port,
                username: rec.username,
                protocol: rec.protocol,
                password: None,
                private_key_path: rec.private_key_path,
                public_key_path: rec.public_key_path,
                passphrase: None,
                trust_persistently: rec.trust_persistently,
                accepted_fingerprint: rec.accepted_fingerprint,
            },
        );

        sessions.entry(rec.id.clone()).or_insert(SessionMeta {
            last_used: now,
            verified_dirs: HashSet::new(),
        });
    }

    Ok(())
}

pub fn clear_secure_connections_memory() {
    // Nur In-Memory-Zustand bereinigen; das verschluesselte DB-File wird in `master_vault::reset_all()` geloescht.
    connection_store()
        .lock()
        .expect("connection mutex poisoned")
        .clear();
    payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .clear();
    session_store()
        .lock()
        .expect("session mutex poisoned")
        .clear();
    sftp_pool_store()
        .lock()
        .expect("sftp pool mutex poisoned")
        .clear();
    ftp_pool_store()
        .lock()
        .expect("ftp pool mutex poisoned")
        .clear();
}

pub fn connect(payload: ConnectPayload) -> Result<ConnectionInfo, ConnectionError> {
    if payload.host.trim().is_empty() {
        return Err(ConnectionError::EmptyHost);
    }
    if payload.username.trim().is_empty() {
        return Err(ConnectionError::EmptyUsername);
    }

    // In der Basisversion speichern wir Metadaten lokal; der SSH-Handshake folgt im nächsten Schritt.
    let connection = ConnectionInfo {
        id: Uuid::new_v4().to_string(),
        host: payload.host.clone(),
        port: payload.port,
        username: payload.username.clone(),
        protocol: payload.protocol.clone(),
    };

    let password_for_keyring = payload.password.clone();

    {
        let mut lock = connection_store().lock().expect("connection mutex poisoned");
        lock.push(connection.clone());
    }
    payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .insert(connection.id.clone(), payload);
    if let Some(password) = password_for_keyring {
        vault::store_secret("fz-next", &connection.id, &password)
            .map_err(|error| ConnectionError::Vault(error.to_string()))?;
    }
    session_store()
        .lock()
        .expect("session mutex poisoned")
        .insert(
            connection.id.clone(),
            SessionMeta {
                last_used: Instant::now(),
                verified_dirs: HashSet::new(),
            },
        );

    // Persistente, verschluesselte Connection-Metadaten sichern (Passwoerter verbleiben im OS Keyring).
    persist_secure_connections_db();
    log_attempt(
        "connect",
        &connection.protocol,
        &connection.host,
        connection.port,
        &connection.username,
        "success",
        None,
    );
    Ok(connection)
}

pub fn update_connection(connection_id: &str, payload: ConnectPayload) -> Result<ConnectionInfo, ConnectionError> {
    if payload.host.trim().is_empty() {
        return Err(ConnectionError::EmptyHost);
    }
    if payload.username.trim().is_empty() {
        return Err(ConnectionError::EmptyUsername);
    }

    let updated_connection = {
        let mut connections = connection_store().lock().expect("connection mutex poisoned");
        let Some(existing) = connections.iter_mut().find(|item| item.id == connection_id) else {
            return Err(ConnectionError::UnknownConnection(connection_id.to_string()));
        };

        existing.host = payload.host.clone();
        existing.port = payload.port;
        existing.username = payload.username.clone();
        existing.protocol = payload.protocol.clone();
        existing.clone()
    };

    payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .insert(connection_id.to_string(), payload.clone());

    if let Some(password) = payload.password.clone() {
        vault::store_secret("fz-next", connection_id, &password)
            .map_err(|error| ConnectionError::Vault(error.to_string()))?;
    }

    session_store()
        .lock()
        .expect("session mutex poisoned")
        .insert(
            connection_id.to_string(),
            SessionMeta {
                last_used: Instant::now(),
                verified_dirs: HashSet::new(),
            },
        );

    // Persistente, verschluesselte Connection-Metadaten sichern (Passwoerter verbleiben im OS Keyring).
    persist_secure_connections_db();

    log_attempt(
        "update_connection",
        &updated_connection.protocol,
        &updated_connection.host,
        updated_connection.port,
        &updated_connection.username,
        "success",
        None,
    );
    Ok(updated_connection)
}

pub fn touch_session(connection_id: &str) {
    if let Some(meta) = session_store()
        .lock()
        .expect("session mutex poisoned")
        .get_mut(connection_id)
    {
        meta.last_used = Instant::now();
    }
}

pub fn is_verified_dir(connection_id: &str, dir_key: &str) -> bool {
    session_store()
        .lock()
        .expect("session mutex poisoned")
        .get(connection_id)
        .is_some_and(|meta| meta.verified_dirs.contains(dir_key))
}

pub fn mark_verified_dir(connection_id: &str, dir_key: &str) {
    if let Some(meta) = session_store()
        .lock()
        .expect("session mutex poisoned")
        .get_mut(connection_id)
    {
        meta.verified_dirs.insert(dir_key.to_string());
    }
}

pub fn invalidate_verified_dir(connection_id: &str, dir_key: &str) {
    if let Some(meta) = session_store()
        .lock()
        .expect("session mutex poisoned")
        .get_mut(connection_id)
    {
        meta.verified_dirs.remove(dir_key);
    }
}

pub fn ensure_warm_connection(connection_id: &str) -> Result<(), ConnectionError> {
    let info = get_connection(connection_id)?;
    if info.protocol == ConnectionProtocol::Sftp {
        let has_entry = sftp_pool_store()
            .lock()
            .expect("sftp pool mutex poisoned")
            .get(connection_id)
            .is_some_and(|pool| !pool.is_empty());
        if !has_entry {
            let (session, sftp) = open_sftp_fresh(connection_id)?;
            let mut lock = sftp_pool_store().lock().expect("sftp pool mutex poisoned");
            let pool = lock.entry(connection_id.to_string()).or_default();
            if pool.len() < POOL_MAX_SIZE {
                pool.push_back(PooledSftp {
                    _session: session,
                    sftp,
                    last_used: Instant::now(),
                });
            }
        }
        touch_session(connection_id);
        return Ok(());
    }
    let has_entry = ftp_pool_store()
        .lock()
        .expect("ftp pool mutex poisoned")
        .get(connection_id)
        .is_some_and(|pool| !pool.is_empty());
    if !has_entry {
        let payload = get_payload(connection_id)?;
        let connection = open_ftp_stream(connection_id, &payload)?;
        let mut lock = ftp_pool_store().lock().expect("ftp pool mutex poisoned");
        let pool = lock.entry(connection_id.to_string()).or_default();
        if pool.len() < POOL_MAX_SIZE {
            pool.push_back(PooledFtp {
                connection,
                last_used: Instant::now(),
            });
        }
    }
    touch_session(connection_id);
    Ok(())
}

pub fn get_connection(connection_id: &str) -> Result<ConnectionInfo, ConnectionError> {
    cleanup_stale_sessions();
    connection_store()
        .lock()
        .expect("connection mutex poisoned")
        .iter()
        .find(|item| item.id == connection_id)
        .cloned()
        .ok_or_else(|| ConnectionError::UnknownConnection(connection_id.to_string()))
}

pub fn open_sftp(connection_id: &str) -> Result<(Session, Sftp), ConnectionError> {
    open_sftp_fresh(connection_id)
}

fn open_sftp_fresh(connection_id: &str) -> Result<(Session, Sftp), ConnectionError> {
    let info = get_connection(connection_id)?;
    if info.protocol != ConnectionProtocol::Sftp {
        return Err(ConnectionError::UnknownConnection(format!(
            "connection {} ist nicht sftp (protocol={})",
            connection_id, info.protocol
        )));
    }
    let payload = payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .get(connection_id)
        .cloned()
        .ok_or_else(|| ConnectionError::UnknownConnection(connection_id.to_string()))?;

    let mut last_error: Option<ConnectionError> = None;
    for _attempt in 1..=3 {
        let connect_result: Result<(Session, Sftp), ConnectionError> = (|| {
            let open_sftp_started = Instant::now();
            log_attempt("open_sftp", &info.protocol, &info.host, info.port, &info.username, "start", None);
            println!(
                "[FTPBOI][BE][open_sftp] connecting tcp host={} port={} user={}",
                info.host, info.port, info.username
            );
            let tcp_started = Instant::now();
            let tcp = TcpStream::connect((info.host.as_str(), info.port))?;
            log_phase_timing(
                "open_sftp",
                "tcp_connect",
                tcp_started.elapsed(),
                &info.protocol,
                &info.host,
                info.port,
                &info.username,
            );
            let mut session = Session::new()?;
            session.set_tcp_stream(tcp);
            println!(
                "[FTPBOI][BE][open_sftp] handshake start host={} port={} user={}",
                info.host, info.port, info.username
            );
            let handshake_started = Instant::now();
            session.handshake()?;
            verify_sftp_trust(&info, &payload, &session)?;
            log_phase_timing(
                "open_sftp",
                "ssh_handshake",
                handshake_started.elapsed(),
                &info.protocol,
                &info.host,
                info.port,
                &info.username,
            );
            println!(
                "[FTPBOI][BE][open_sftp] handshake success host={} port={} user={}",
                info.host, info.port, info.username
            );

            let auth_started = Instant::now();
            authenticate_session(connection_id, &info.username, &payload, &mut session)?;
            log_phase_timing(
                "open_sftp",
                "auth",
                auth_started.elapsed(),
                &info.protocol,
                &info.host,
                info.port,
                &info.username,
            );
            if !session.authenticated() {
                return Err(ConnectionError::AuthFailed);
            }
            println!(
                "[FTPBOI][BE][open_sftp] sftp stream init start host={} port={} user={}",
                info.host, info.port, info.username
            );
            let sftp_init_started = Instant::now();
            let sftp = session.sftp()?;
            log_phase_timing(
                "open_sftp",
                "sftp_init",
                sftp_init_started.elapsed(),
                &info.protocol,
                &info.host,
                info.port,
                &info.username,
            );
            log_phase_timing(
                "open_sftp",
                "total",
                open_sftp_started.elapsed(),
                &info.protocol,
                &info.host,
                info.port,
                &info.username,
            );
            println!(
                "[FTPBOI][BE][open_sftp] sftp stream init success host={} port={} user={}",
                info.host, info.port, info.username
            );
            Ok((session, sftp))
        })();

        match connect_result {
            Ok((session, sftp)) => {
                touch_session(connection_id);
                log_attempt("open_sftp", &info.protocol, &info.host, info.port, &info.username, "success", None);
                return Ok((session, sftp));
            }
            Err(error) => {
                eprintln!(
                    "[FTPBOI][BE][open_sftp] failed host={} port={} user={} reason={}",
                    info.host, info.port, info.username, error
                );
                log_attempt(
                    "open_sftp",
                    &info.protocol,
                    &info.host,
                    info.port,
                    &info.username,
                    "error",
                    Some(&error.to_string()),
                );
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    Err(last_error.unwrap_or(ConnectionError::UnknownConnection(connection_id.to_string())))
}

pub fn test_connection(payload: ConnectPayload) -> Result<String, ConnectionError> {
    if payload.host.trim().is_empty() {
        return Err(ConnectionError::EmptyHost);
    }
    if payload.username.trim().is_empty() {
        return Err(ConnectionError::EmptyUsername);
    }

    let protocol = payload.protocol.clone();
    log_attempt("test_connection", &protocol, &payload.host, payload.port, &payload.username, "start", None);
    match protocol {
        ConnectionProtocol::Sftp => {
            let tcp = TcpStream::connect((payload.host.as_str(), payload.port))?;
            let mut session = Session::new()?;
            session.set_tcp_stream(tcp);
            session.handshake()?;
            let info = ConnectionInfo {
                id: "connection-test".to_string(),
                host: payload.host.clone(),
                port: payload.port,
                username: payload.username.clone(),
                protocol: payload.protocol.clone(),
            };
            verify_sftp_trust(&info, &payload, &session)?;
            authenticate_session("connection-test", &payload.username, &payload, &mut session)?;
            if !session.authenticated() {
                return Err(ConnectionError::AuthFailed);
            }
            let _ = session.sftp()?;
        }
        ConnectionProtocol::Ftp | ConnectionProtocol::Ftps => {
            let mut ftp = open_ftp_stream("connection-test", &payload)?;
            ftp.quit().map_err(map_ftp_error)?;
        }
    }
    log_attempt("test_connection", &payload.protocol, &payload.host, payload.port, &payload.username, "success", None);
    Ok("ok".to_string())
}

fn authenticate_session(
    connection_id: &str,
    username: &str,
    payload: &ConnectPayload,
    session: &mut Session,
) -> Result<(), ConnectionError> {
    if let Some(private_key_path) = &payload.private_key_path {
        let private_key = PathBuf::from(private_key_path);
        let public_key = payload.public_key_path.as_ref().map(PathBuf::from);
        let passphrase = payload.passphrase.clone();
        session.userauth_pubkey_file(
            username,
            public_key.as_deref(),
            &private_key,
            passphrase.as_deref(),
        )?;
        if session.authenticated() {
            return Ok(());
        }
    }

    let password = match &payload.password {
        Some(pwd) => Some(pwd.clone()),
        None => vault::get_password(connection_id).ok(),
    };
    let Some(password) = password else {
        return Err(ConnectionError::MissingPassword);
    };
    session.userauth_password(username, &password)?;
    if session.authenticated() {
        return Ok(());
    }
    Err(ConnectionError::AuthUnavailable)
}

pub fn get_payload(connection_id: &str) -> Result<ConnectPayload, ConnectionError> {
    payload_store()
        .lock()
        .expect("payload mutex poisoned")
        .get(connection_id)
        .cloned()
        .ok_or_else(|| ConnectionError::UnknownConnection(connection_id.to_string()))
}

pub fn resolve_password(connection_id: &str, payload: &ConnectPayload) -> Result<String, ConnectionError> {
    match &payload.password {
        Some(pwd) => Ok(pwd.clone()),
        None => vault::get_password(connection_id).map_err(|_| ConnectionError::MissingPassword),
    }
}

pub fn open_ftp_stream(connection_id: &str, payload: &ConnectPayload) -> Result<FtpConnection, ConnectionError> {
    let addr = format!("{}:{}", payload.host, payload.port);
    let password = resolve_password(connection_id, payload)?;
    let open_started = Instant::now();
    if payload.protocol == ConnectionProtocol::Ftps {
        // Protocol range is enforced here; cipher suites follow the platform TLS stack
        // (Security.framework on macOS, Schannel on Windows, OpenSSL where applicable).
        // See CLAUDE.md → Security & TLS (FTPS).
        let tls = TlsConnector::builder()
            .min_protocol_version(Some(suppaftp::native_tls::Protocol::Tlsv12))
            .max_protocol_version(Some(suppaftp::native_tls::Protocol::Tlsv13))
            .build()
            .map_err(|error| ConnectionError::FtpsSetup(error.to_string()))?;
        let connect_started = Instant::now();
        let ftp = NativeTlsFtpStream::connect(addr).map_err(map_ftp_error)?;
        log_phase_timing(
            "open_ftp",
            "connect",
            connect_started.elapsed(),
            &payload.protocol,
            &payload.host,
            payload.port,
            &payload.username,
        );
        let tls_started = Instant::now();
        let mut ftp = ftp
            .into_secure(NativeTlsConnector::from(tls), &payload.host)
            .map_err(|error| {
                let event = SecurityEvent {
                    kind: "untrusted_cert".to_string(),
                    host: payload.host.clone(),
                    port: payload.port,
                    protocol: "ftps".to_string(),
                    fingerprint: payload.accepted_fingerprint.clone(),
                    expected_fingerprint: None,
                    issuer: None,
                    valid_from: None,
                    valid_to: None,
                    message: error.to_string(),
                };
                ConnectionError::Security(serde_json::to_string(&event).unwrap_or_else(|_| error.to_string()))
            })?;
        log_phase_timing(
            "open_ftp",
            "tls_upgrade",
            tls_started.elapsed(),
            &payload.protocol,
            &payload.host,
            payload.port,
            &payload.username,
        );
        let login_started = Instant::now();
        ftp.login(&payload.username, &password).map_err(map_ftp_error)?;
        log_phase_timing(
            "open_ftp",
            "login",
            login_started.elapsed(),
            &payload.protocol,
            &payload.host,
            payload.port,
            &payload.username,
        );
        log_phase_timing(
            "open_ftp",
            "total",
            open_started.elapsed(),
            &payload.protocol,
            &payload.host,
            payload.port,
            &payload.username,
        );
        return Ok(FtpConnection::Secure(ftp));
    }
    let connect_started = Instant::now();
    let mut ftp = FtpStream::connect(addr).map_err(map_ftp_error)?;
    log_phase_timing(
        "open_ftp",
        "connect",
        connect_started.elapsed(),
        &payload.protocol,
        &payload.host,
        payload.port,
        &payload.username,
    );
    let login_started = Instant::now();
    ftp.login(&payload.username, &password).map_err(map_ftp_error)?;
    log_phase_timing(
        "open_ftp",
        "login",
        login_started.elapsed(),
        &payload.protocol,
        &payload.host,
        payload.port,
        &payload.username,
    );
    log_phase_timing(
        "open_ftp",
        "total",
        open_started.elapsed(),
        &payload.protocol,
        &payload.host,
        payload.port,
        &payload.username,
    );
    Ok(FtpConnection::Plain(ftp))
}

pub fn with_pooled_sftp<T, F>(connection_id: &str, operation: F) -> Result<T, ConnectionError>
where
    F: FnOnce(&Sftp) -> Result<T, ConnectionError>,
{
    cleanup_stale_sessions();
    let mut pooled = sftp_pool_store()
        .lock()
        .expect("sftp pool mutex poisoned")
        .get_mut(connection_id)
        .and_then(|pool| pool.pop_front());
    if pooled.is_none() {
        let (session, sftp) = open_sftp_fresh(connection_id)?;
        pooled = Some(PooledSftp {
            _session: session,
            sftp,
            last_used: Instant::now(),
        });
    }
    let mut entry = pooled.expect("pooled sftp missing");
    let result = operation(&entry.sftp);
    if result.is_ok() {
        entry.last_used = Instant::now();
        let mut lock = sftp_pool_store().lock().expect("sftp pool mutex poisoned");
        let pool = lock.entry(connection_id.to_string()).or_default();
        if pool.len() < POOL_MAX_SIZE {
            pool.push_back(entry);
        }
        touch_session(connection_id);
    }
    result
}

pub fn with_pooled_ftp<T, F>(connection_id: &str, operation: F) -> Result<T, ConnectionError>
where
    F: FnOnce(&mut FtpConnection) -> Result<T, ConnectionError>,
{
    cleanup_stale_sessions();
    let mut pooled = ftp_pool_store()
        .lock()
        .expect("ftp pool mutex poisoned")
        .get_mut(connection_id)
        .and_then(|pool| pool.pop_front());
    if pooled.is_none() {
        let payload = get_payload(connection_id)?;
        let connection = open_ftp_stream(connection_id, &payload)?;
        pooled = Some(PooledFtp {
            connection,
            last_used: Instant::now(),
        });
    }
    let mut entry = pooled.expect("pooled ftp missing");
    let result = operation(&mut entry.connection);
    if result.is_ok() {
        entry.last_used = Instant::now();
        let mut lock = ftp_pool_store().lock().expect("ftp pool mutex poisoned");
        let pool = lock.entry(connection_id.to_string()).or_default();
        if pool.len() < POOL_MAX_SIZE {
            pool.push_back(entry);
        }
        touch_session(connection_id);
    }
    result
}

fn map_ftp_error(error: FtpError) -> ConnectionError {
    ConnectionError::Ftp(error.to_string())
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn hostkey_fingerprint(session: &Session) -> Result<String, ConnectionError> {
    let (hostkey, _) = session
        .host_key()
        .ok_or_else(|| ConnectionError::AuthUnavailable)?;
    let mut hasher = Sha256::new();
    hasher.update(hostkey);
    Ok(format!("SHA256:{}", hex::encode(hasher.finalize())))
}

fn verify_sftp_trust(info: &ConnectionInfo, payload: &ConnectPayload, session: &Session) -> Result<(), ConnectionError> {
    let fingerprint = hostkey_fingerprint(session)?;
    let existing = trust_store::get_trust_record(&info.host, info.port, "sftp")
        .map_err(ConnectionError::Vault)?;
    if let Some(existing_record) = existing {
        if existing_record.fingerprint != fingerprint {
            let event = SecurityEvent {
                kind: "fingerprint_changed".to_string(),
                host: info.host.clone(),
                port: info.port,
                protocol: "sftp".to_string(),
                fingerprint: Some(fingerprint),
                expected_fingerprint: Some(existing_record.fingerprint),
                issuer: existing_record.issuer,
                valid_from: existing_record.valid_from,
                valid_to: existing_record.valid_to,
                message: "Sicherheitswarnung: Der Fingerabdruck des Servers hat sich geändert! Dies könnte ein Angriff sein.".to_string(),
            };
            return Err(ConnectionError::Security(
                serde_json::to_string(&event).unwrap_or_else(|_| "fingerprint changed".to_string()),
            ));
        }
        return Ok(());
    }
    if payload.trust_persistently && payload.accepted_fingerprint.as_deref() == Some(fingerprint.as_str()) {
        let ts = now_ts();
        trust_store::upsert_trust_record(&TrustRecord {
            host: info.host.clone(),
            port: info.port,
            protocol: "sftp".to_string(),
            fingerprint,
            issuer: None,
            valid_from: None,
            valid_to: None,
            first_seen: ts,
            last_seen: ts,
        })
        .map_err(ConnectionError::Vault)?;
        return Ok(());
    }
    let event = SecurityEvent {
        kind: "unknown_hostkey".to_string(),
        host: info.host.clone(),
        port: info.port,
        protocol: "sftp".to_string(),
        fingerprint: Some(fingerprint),
        expected_fingerprint: None,
        issuer: None,
        valid_from: None,
        valid_to: None,
        message: "Unbekannter Host-Fingerabdruck. Bitte vor dem Verbinden verifizieren.".to_string(),
    };
    Err(ConnectionError::Security(
        serde_json::to_string(&event).unwrap_or_else(|_| "unknown hostkey".to_string()),
    ))
}

fn log_attempt(
    phase: &str,
    protocol: &ConnectionProtocol,
    host: &str,
    port: u16,
    username: &str,
    result: &str,
    message: Option<&str>,
) {
    match message {
        Some(msg) => eprintln!(
            "[connection] phase={} protocol={} host={} port={} username={} result={} message={}",
            phase, protocol, host, port, username, result, msg
        ),
        None => println!(
            "[connection] phase={} protocol={} host={} port={} username={} result={}",
            phase, protocol, host, port, username, result
        ),
    }
}

fn log_phase_timing(
    phase: &str,
    step: &str,
    elapsed: Duration,
    protocol: &ConnectionProtocol,
    host: &str,
    port: u16,
    username: &str,
) {
    let elapsed_ms = elapsed.as_millis();
    println!(
        "[connection-timing] phase={} step={} elapsed_ms={} protocol={} host={} port={} username={}",
        phase, step, elapsed_ms, protocol, host, port, username
    );
}
